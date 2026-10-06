const express = require('express');
const path = require('path');
const { parseSubscriptionList, extractClashDns } = require('./src/parser');
const { convertToClash, convertToSurge } = require('./src/converter');
const { requestSubscription, parseRuleOptions, applySubscriptionHeaders } = require('./src/utils');const { readConfig } = require('./src/user-config');
const { pickUserAgent } = require('./src/user-agents');
const apiRouter = require('./src/api');

const os = require('os');

const app = express();
const PORT = process.env.PORT || 25500;

// 获取本机局域网 IP
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  // 订阅元信息走自定义响应头（subscription-userinfo 等），
  // 浏览器调用时需要显式暴露才能读到。
  res.header(
    'Access-Control-Expose-Headers',
    'subscription-userinfo, profile-web-page-url, profile-update-interval, Content-Disposition'
  );
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===================== 路由 =====================

// 配置页面
app.get('/config', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'config.html'));
});

// 配置 API
app.use('/api', apiRouter);

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * subconverter 兼容端点 - 专供 OpenClash
 * OpenClash 发送: /sub?target=clash&url=...&config=...&include=...&exclude=...&emoji=...&udp=...
 */
app.get('/sub', async (req, res) => {
  try {
    const {
      target = 'clash',
      url,
      config: templateUrl,
      include,
      exclude,
      emoji,
      udp,
      scv,
      sort,
      append_type,
      ua,
    } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // 多个 URL 用 | 分隔
    const urls = url.split('|').map(u => u.trim()).filter(Boolean);

    // 拉取订阅时使用的 UA：?ua= 显式指定 > 配置 > 透传调用方（浏览器则回退预设）
    const callerUA = req.get('user-agent') || '';
    const { fetch: fetchCfg = {} } = readConfig();
    const fetchOpts = { userAgent: ua || pickUserAgent(fetchCfg, callerUA) };
    console.log(
      `[sub] target=${target} urls=${urls.length}` +
      ` caller-ua="${callerUA || '(空)'}"` +
      ` mode=${ua ? 'query' : (fetchCfg.userAgent || 'auto')}` +
      ` -> send-ua="${fetchOpts.userAgent}"` +
      ` include=${include || '-'} exclude=${exclude || '-'}`
    );

    // 获取所有订阅内容，同时收集机场下发的元信息（流量 / 到期 / 官网 / 文件名）
    let allContent = '';
    const metas = [];
    const failures = [];
    for (const u of urls) {
      try {
        const decodedUrl = u.startsWith('http') ? u : decodeURIComponent(u);
        const result = await requestSubscription(decodedUrl, fetchOpts);
        allContent += (allContent ? '\n' : '') + result.text;
        metas.push(result);
      } catch (err) {
        // 日志/响应里隐去订阅地址中的凭据，避免泄漏 token
        const safe = u
          .replace(/\/\/[^@/]*@/, '//')
          .replace(/([?&](token|sub|code|key)=)[^&]+/gi, '$1***');
        failures.push({ url: safe, reason: err.message });
        console.warn(`[sub] 获取失败: ${safe} - ${err.message}`);
      }
    }

    if (!allContent) {
      // 常见原因：机场安全规则拦截（403/451）、订阅地址已失效、拉取 UA 与客户端不一致
      const hasHttpError = failures.some(f => /HTTP 4\d\d/.test(f.reason));
      const hint = hasHttpError
        ? '订阅源返回了错误状态码：订阅地址可能已失效，或拉取所用 UA 被机场安全规则拦截。请先在「配置界面 → 订阅拉取设置」中选择与你客户端一致的 UA。'
        : '无法连接到订阅源，请检查网络或订阅地址。';
      return res.status(400).json({ error: 'Failed to fetch any subscription', hint, failures });
    }

    // 多订阅必须分别解析再合并：把多份 YAML 直接拼接会产生重复根键，
    // yaml.load 会直接失败（表现为「No valid proxies found」）。
    const { proxies, dropped } = parseSubscriptionList(metas.map(m => m.text));
    if (dropped) console.log(`[sub] 合并多订阅时丢弃 ${dropped} 个同名节点`);

    if (proxies.length === 0) {
      return res.status(400).json({ error: 'No valid proxies found' });
    }

    console.log(`[sub] 解析到 ${proxies.length} 个节点`);

    // 把机场的流量 / 到期 / 官网信息转发给客户端，否则 Clash 面板上订阅详情为空白
    applySubscriptionHeaders(res, metas);
    const forwarded = ['subscription-userinfo', 'profile-web-page-url',
      'profile-update-interval', 'Content-Disposition']
      .filter(h => res.getHeader(h))
      .map(h => `${h}=${res.getHeader(h)}`);
    console.log(forwarded.length
      ? `[sub] 已转发订阅信息: ${forwarded.join(' | ')}`
      : '[sub] 订阅源未下发流量 / 到期信息（该机场不支持）');

    const ruleOptions = parseRuleOptions(include, exclude);

    if (target.startsWith('surge')) {
      res.type('text/plain').send(convertToSurge(proxies, { ruleOptions }));
    } else {
      // 源订阅若自带 Clash DNS 配置则透传，保证与直接导入等价。
      // 必须扫全部订阅再取第一个命中的：早期只取 metas[0]，
      // 于是「第一份是 URI 列表、第二份是 Clash YAML」时 dns 会静默丢失，
      // 与 /api/convert（sources.map(extractClashDns).find(Boolean)）行为不一致。
      const srcDns = metas.map(m => extractClashDns(m.text)).find(Boolean);
      const convertOptions = { ruleOptions };
      if (srcDns) convertOptions.dns = srcDns;
      res.type('text/yaml').send(convertToClash(proxies, convertOptions).yaml);
    }
  } catch (err) {
    // 全部节点被过滤属用户配置问题：返回 400 + 可操作提示，而非 500 服务端错误
    if (err.code === 'ALL_PROXIES_FILTERED') {
      console.warn('[sub]', err.message);
      // 上边的 applySubscriptionHeaders 可能已设置下载头，
      // 这里必须撤掉，否则浏览器会把错误 JSON 当成文件下载。
      res.removeHeader('Content-Disposition');
      return res.status(400).json({ error: err.message, hint: err.hint });
    }
    console.error('[sub] 错误:', err.message);
    res.status(500).json({ error: 'Convert failed: ' + err.message });
  }
});

// ===================== 启动 =====================

// 启动服务
app.listen(PORT, () => {
  const localIP = getLocalIP();
  const base = `http://${localIP}:${PORT}`;
  console.log(`\n🚀 Clash 订阅转换器已启动（端口 ${PORT}）\n`);
  console.log(`   ① 使用说明页 — 浏览器打开，查看部署步骤与用法`);
  console.log(`      ${base}/`);
  console.log(`   ② 配置界面 — 浏览器打开，管理订阅链接 / 节点过滤 / 分组策略`);
  console.log(`      ${base}/config`);
  console.log(`   ③ 订阅转换地址 — 填入 OpenClash，必须带 url 参数`);
  console.log(`      ${base}/sub?target=clash&url=<订阅链接>`);
  console.log(`\n   本机访问可用 http://127.0.0.1:${PORT}\n`);
});

module.exports = app;
