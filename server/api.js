const express = require('express');
const { fetchSubscription } = require('../src/fetcher');
const { readConfig, saveConfig } = require('../src/user/user-config');
const { listPresets, resolveUserAgent } = require('../src/user/user-agents');
const { parseSubscription, parseSubscriptionList, extractClashDns } = require('../src/parser');
const { isDomestic, CN_LABEL } = require('../src/proxy-groups');
const { ruleManager } = require('../src/rule-manager');
const { convertToClash } = require('../src/converter');
const guests = require('../src/user/guests');
const logger = require('../src/logger');

const log = logger.create('api');

const router = express.Router();

// ===================== 工具函数 =====================

/**
 * 解析本次拉取应使用的 UA，并带上它的来源（仅用于日志）
 *
 * UA 是用户配置的一部分：不同访客可以各用各的 UA（同一机场对不同客户端
 * 可能下发不同结果，部分机场还会按 UA 拦截）。因此这里必须读「本请求对应的
 * 那份配置」，而不是统一的 config.json。
 *
 * @param {Object} req      express 请求
 * @param {string} override 请求体里显式指定的 UA（优先级最高）
 */
function uaOptions(req, override) {
  const { fetch: fetchCfg = {} } = readConfig(guests.guestIdFrom(req));
  const callerUA = req.get('user-agent') || '';
  if (override) return { userAgent: override, uaSource: '请求体显式指定' };
  const resolved = resolveUserAgent(fetchCfg, callerUA);
  return { userAgent: resolved.ua, uaSource: resolved.source };
}

/**
 * 统一的转换错误响应。
 * 全部节点被过滤掉属用户输入问题 → 400（客户端应据此提示用户改配置），
 * 其余才是服务端故障 → 500。
 */
function sendConvertError(res, err, tag) {
  if (err.code === 'ALL_PROXIES_FILTERED') {
    log.warn(`${tag} 全部节点被过滤条件排除`, { err: err.message, nodes: err.totalNodes, hint: err.hint });
    return res.status(400).json({
      error: err.message,
      hint: err.hint,
      totalNodes: err.totalNodes
    });
  }
  log.fail(`${tag} 转换失败`, err);
  res.status(500).json({ error: '转换失败: ' + err.message });
}

// ===================== 订阅解析 =====================

/**
 * POST /api/parse
 * 请求体: { url: "订阅地址" }
 * 返回: { nodes: [{ name, type, region }, ...] }
 */
router.post('/parse', async (req, res) => {
  try {
    const { url, userAgent } = req.body;
    log.info('POST /api/parse', { url: logger.safeUrl(url), hasUa: !!userAgent });
    if (!url) {
      log.warn('POST /api/parse 缺少 url 参数');
      return res.status(400).json({ error: '缺少 url 参数' });
    }

    const uaOpts = uaOptions(req, userAgent);
    log.debug('拉取 UA 已确定', { ua: uaOpts.userAgent, 'ua-source': uaOpts.uaSource });
    const content = await fetchSubscription(url, uaOpts);
    const proxies = parseSubscription(content);

    const nodes = proxies.map(p => ({
      name: p.name,
      type: p.type,
      region: isDomestic(p.name) ? CN_LABEL : '🌐 其他',
    }));

    log.info('POST /api/parse 完成', { nodes: nodes.length });
    res.json({ nodes, total: nodes.length });
  } catch (err) {
    log.fail('POST /api/parse 失败', err);
    res.status(500).json({ error: '解析失败: ' + err.message });
  }
});

// ===================== 文件转换 =====================

/**
 * POST /api/convert-file
 * 请求体: { content: "原始的订阅 YAML/base64 内容" }
 * 返回: { yaml: "转换后的 Clash YAML" }
 */
router.post('/convert-file', (req, res) => {
  try {
    const { content } = req.body;
    log.info('POST /api/convert-file', {
      bytes: content ? logger.formatBytes(Buffer.byteLength(content, 'utf-8')) : 0,
    });
    if (!content || !content.trim()) {
      log.warn('POST /api/convert-file 缺少文件内容');
      return res.status(400).json({ error: '缺少文件内容' });
    }

    const proxies = parseSubscription(content);
    if (proxies.length === 0) {
      log.warn('POST /api/convert-file 未找到有效代理节点');
      return res.status(400).json({ error: '未找到有效代理节点' });
    }

    // 源订阅若自带 Clash DNS 配置则透传，保证与直接导入等价
    const convertOptions = { guestId: guests.guestIdFrom(req) };
    const srcDns = extractClashDns(content);
    if (srcDns) convertOptions.dns = srcDns;

    const result = convertToClash(proxies, convertOptions);
    log.info('POST /api/convert-file 完成', { proxies: proxies.length, dns: srcDns ? '有' : '无' });
    res.json({ yaml: result.yaml, count: proxies.length });
  } catch (err) {
    sendConvertError(res, err, '[api/convert-file]');
  }
});

// ===================== 完整转换（支持多URL + 过滤参数） =====================

/**
 * POST /api/convert
 * 请求体: { urls: ["url1","url2"], nodeFilter: "all|hideDomestic|hideInternational", excludeKeywords: ["关键词"] }
 * 返回: { yaml, summary: { totalNodes, filteredNodes, groups: [{name, type, proxies}] } }
 */
router.post('/convert', async (req, res) => {
  const clog = logger.create(`api/convert#${logger.reqId()}`);
  const timer = logger.timer();

  try {
    const { urls = [], nodeFilter = 'all', excludeKeywords = [], rawContent, userAgent } = req.body;

    const client = req.ip || req.socket.remoteAddress || '-';
    clog.info('请求进入', {
      client,
      urls: urls.length,
      nodeFilter,
      excludeKeywords: excludeKeywords.length,
      rawContent: rawContent ? logger.formatBytes(Buffer.byteLength(rawContent, 'utf-8')) : '无',
      'caller-ua': req.get('user-agent') || '(空)',
    });
    if (urls.length) clog.debug('订阅地址清单', { urls: urls.map(u => logger.safeUrl(u)) });

    // 保留每一份订阅的原始文本，分别解析后再合并
    const sources = [];
    // 拉取失败的记录，脚本末尾统一汇总（每份一条，不刷屏）
    const fetchFailures = [];
    // 实际使用的 UA 与来源，失败汇总时要回显——UA 被机场拉黑是常见原因
    let usedUa = '';
    let usedUaSource = '';

    // 支持两种来源：URL 或直接内容（文件上传）
    if (rawContent && rawContent.trim()) {
      sources.push(rawContent);
      clog.debug('数据源：直接上传的内容');
    } else {
      if (!urls.length) {
        clog.warn('缺少订阅链接');
        return res.status(400).json({ error: '缺少订阅链接' });
      }
      const fetchOpts = uaOptions(req, userAgent);
      usedUa = fetchOpts.userAgent;
      usedUaSource = fetchOpts.uaSource;
      clog.debug('拉取 UA 已确定', { ua: fetchOpts.userAgent, 'ua-source': fetchOpts.uaSource });
      for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        try {
          clog.debug(`拉取订阅 ${i + 1}/${urls.length}`, { url: logger.safeUrl(u) });
          sources.push(await fetchSubscription(u, fetchOpts));
        } catch (err) {
          // 必须脱敏：订阅地址里的 token 不能进日志
          const safe = logger.safeUrl(u);
          fetchFailures.push({
            url: safe,
            reason: err.failReason || err.message,
            stage: err.stage,
            status: err.status,
            code: err.status ? undefined : err.netCode,
          });
          clog.warn(`拉取订阅 ${i + 1}/${urls.length} 失败`, {
            url: safe,
            host: logger.hostOf(u),
            'fail-stage': err.stage,
            status: err.status,
            'net-code': err.netCode,
            reason: err.failReason || err.message,
            hint: err.hint,
          });
        }
      }
    }

    if (!sources.some(s => s && s.trim())) {
      clog.warn('无法获取任何订阅内容，终止转换', {
        attempted: urls.length,
        'by-stage': fetchFailures.length ? logger.countBy(fetchFailures, f => f.stage || '其他') : undefined,
        'by-reason': fetchFailures.length ? logger.countBy(fetchFailures, f => f.reason) : undefined,
        'by-net-code': fetchFailures.some(f => f.code)
          ? logger.countBy(fetchFailures.filter(f => f.code), f => f.code)
          : undefined,
        'ua-used': usedUa || undefined,
        'ua-source': usedUaSource || undefined,
        failures: fetchFailures.length
          ? fetchFailures.map(f => `${f.url} → ${f.reason}${f.code ? `（${f.code}）` : ''}`)
          : undefined,
      });
      return res.status(400).json({ error: '无法获取任何订阅内容' });
    }

    const { proxies, dropped } = parseSubscriptionList(sources);
    if (dropped) clog.info('合并多订阅时丢弃同名节点', { dropped });
    if (proxies.length === 0) {
      clog.warn('解析后没有任何有效节点，终止转换', { sources: sources.length });
      return res.status(400).json({ error: '未找到有效代理节点' });
    }

    // 构建过滤参数
    const nodeFilters = {
      hideDomestic: nodeFilter === 'hideDomestic',
      hideInternational: nodeFilter === 'hideInternational'
    };

    // 源订阅若自带 Clash DNS 配置则透传，保证与直接导入等价
    const srcDns = sources.map(extractClashDns).find(Boolean);
    // guestId 必须带上：过滤开关与分组策略都来自「本请求对应的那份配置」
    const convertOptions = { nodeFilters, excludeKeywords, guestId: guests.guestIdFrom(req) };
    if (srcDns) convertOptions.dns = srcDns;

    clog.debug('开始转换', { proxies: proxies.length, nodeFilters, dns: srcDns ? '有' : '无' });

    const result = convertToClash(proxies, convertOptions);

    clog.info('转换完成，准备响应', {
      totalNodes: result.summary.totalNodes,
      filteredNodes: result.summary.filteredNodes,
      // 这里比 converter 的 groups 多 2 个：summary 里还追加了本地路由 / GEOIP 两个系统分组
      groupsIncSystem: result.summary.groups.length,
      out: logger.formatBytes(Buffer.byteLength(result.yaml, 'utf-8')),
      dur: timer.text(),
    });

    res.json({
      yaml: result.yaml,
      summary: result.summary
    });
  } catch (err) {
    sendConvertError(res, err, '[api/convert]');
  }
});

// ===================== 用户配置 =====================

/**
 * GET /api/user-agents
 * 返回可选客户端 UA 预设
 */
router.get('/user-agents', (req, res) => {
  res.json({ presets: listPresets() });
});

/**
 * GET /api/config
 * 返回当前请求对应的配置（管理员 = 站点基准，访客 = 站点基准 + 自己那份差异）；
 * scope 用于让页面显示「你正在改的是哪一份配置」。
 */
router.get('/config', (req, res) => {
  const scope = guests.scopeOf(req);
  const config = readConfig(scope.guest);
  log.debug('GET /api/config', { ip: scope.ip, scope: scope.guest || '站点基准' });
  res.json({ ...config, scope });
});

/**
 * POST /api/config
 * 保存配置 —— 仅存储与下层基准的差异（管理员写 config.json，访客写 guests/<IP>.json）
 */
router.post('/config', (req, res) => {
  const scope = guests.scopeOf(req);
  try {
    const newConfig = req.body;
    if (!newConfig || !Array.isArray(newConfig.groups)) {
      log.warn('POST /api/config 配置格式无效', {
        hasBody: !!newConfig,
        keys: newConfig ? Object.keys(newConfig) : null,
        scope: scope.guest || '站点基准',
      });
      return res.status(400).json({ error: '无效的配置格式' });
    }

    const saved = saveConfig(newConfig, scope.guest);
    log.info('POST /api/config 完成', {
      groups: newConfig.groups.length,
      ip: scope.ip,
      scope: scope.guest || '站点基准',
    });
    res.json({ success: true, config: saved, scope });
  } catch (err) {
    log.fail('POST /api/config 保存失败', err);
    res.status(500).json({ error: '保存失败: ' + err.message });
  }
});

// ===================== 规则管理 =====================

/**
 * GET /api/rules
 * 获取所有规则配置
 */
router.get('/rules', (req, res) => {
  res.json(ruleManager.getAll());
});

/**
 * GET /api/rules/:id
 * 获取单个规则配置
 */
router.get('/rules/:id', (req, res) => {
  const rule = ruleManager.getById(req.params.id);
  if (!rule) return res.status(404).json({ error: '规则不存在' });
  res.json(rule);
});

/**
 * POST /api/rules
 * 添加新规则
 */
router.post('/rules', (req, res) => {
  try {
    const rule = ruleManager.add(req.body);
    res.json(rule);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * PUT /api/rules/:id
 * 更新规则
 */
router.put('/rules/:id', (req, res) => {
  try {
    const rule = ruleManager.update(req.params.id, req.body);
    res.json(rule);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * DELETE /api/rules/:id
 * 删除规则
 */
router.delete('/rules/:id', (req, res) => {
  try {
    ruleManager.remove(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
