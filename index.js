const express = require('express');
const fs = require('fs');
const path = require('path');
const { parseSubscription } = require('./src/parser');
const { convertToClash, convertToSurge } = require('./src/converter');
const { fetchSubscription, parseRuleOptions } = require('./src/utils');
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
    } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // 多个 URL 用 | 分隔
    const urls = url.split('|').map(u => u.trim()).filter(Boolean);
    console.log(`[sub] target=${target} urls=${urls.length} include=${include || '-'} exclude=${exclude || '-'}`);

    // 获取所有订阅内容
    let allContent = '';
    for (const u of urls) {
      try {
        const decodedUrl = u.startsWith('http') ? u : decodeURIComponent(u);
        allContent += (allContent ? '\n' : '') + await fetchSubscription(decodedUrl);
      } catch (err) {
        console.warn(`[sub] 获取失败: ${u} - ${err.message}`);
      }
    }

    if (!allContent) {
      return res.status(400).json({ error: 'Failed to fetch any subscription' });
    }

    const proxies = parseSubscription(allContent);
    if (proxies.length === 0) {
      return res.status(400).json({ error: 'No valid proxies found' });
    }

    console.log(`[sub] 解析到 ${proxies.length} 个节点`);

    const ruleOptions = parseRuleOptions(include, exclude);

    if (target.startsWith('surge')) {
      res.type('text/plain').send(convertToSurge(proxies, { ruleOptions }));
    } else {
      res.type('text/yaml').send(convertToClash(proxies, { ruleOptions }).yaml);
    }
  } catch (err) {
    console.error('[sub] 错误:', err.message);
    res.status(500).json({ error: 'Convert failed: ' + err.message });
  }
});

// ===================== 启动 =====================

const args = process.argv.slice(2);
const isServer = args.includes('--server') || args.includes('-s');

// 首次启动：拷贝默认配置文件
const configDir = path.join(__dirname, 'config');
const configPath = path.join(configDir, 'config.json');
const defaultConfigPath = path.join(configDir, 'default.json');
if (!fs.existsSync(configPath) && fs.existsSync(defaultConfigPath)) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.copyFileSync(defaultConfigPath, configPath);
  console.log('[init] 已创建 config/config.json（从 default.json 拷贝）');
}

if (isServer) {
  app.listen(PORT, () => {
    const localIP = getLocalIP();
    console.log(`\n🚀 服务已启动: http://127.0.0.1:${PORT}`);
    console.log(`   OpenClash 配置地址: http://${localIP}:${PORT}/config`);
    console.log(`   OpenClash 转换地址: http://${localIP}:${PORT}/sub\n`);
  });
} else {
  const yamlFile = args.find(a => a.endsWith('.yaml') || a.endsWith('.yml'));

  if (!yamlFile) {
    console.log('用法:');
    console.log('  服务模式: node index.js --server');
    console.log('  本地转换: node index.js <file.yaml>');
    process.exit(0);
  }

  const filePath = path.resolve(yamlFile);
  if (!fs.existsSync(filePath)) {
    console.error(`[错误] 文件不存在: ${filePath}`);
    process.exit(1);
  }

  console.log(`[转换] 读取: ${filePath}`);
  const content = fs.readFileSync(filePath, 'utf-8');
  const proxies = parseSubscription(content);

  if (proxies.length === 0) {
    console.log('[警告] 未解析到节点');
    process.exit(1);
  }

  console.log(`[转换] ${proxies.length} 个节点\n`);
  const name = path.basename(yamlFile, path.extname(yamlFile));
  console.log(convertToClash(proxies, { name }).yaml);
}

module.exports = app;
