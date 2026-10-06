const express = require('express');
const { fetchSubscription } = require('./utils');
const { readConfig, saveConfig } = require('./user-config');
const { listPresets, pickUserAgent } = require('./user-agents');
const { parseSubscription, parseSubscriptionList, extractClashDns } = require('./parser');
const { isDomestic, CN_LABEL } = require('./proxy-groups');
const { ruleManager } = require('./rule-manager');
const { convertToClash } = require('./converter');
const logger = require('./logger');

const log = logger.create('api');

const router = express.Router();

// ===================== 工具函数 =====================

/**
 * 解析本次拉取应使用的 UA
 * @param {Object} req      express 请求
 * @param {string} override 请求体里显式指定的 UA（优先级最高）
 */
function uaOptions(req, override) {
  const { fetch: fetchCfg = {} } = readConfig();
  const callerUA = req.get('user-agent') || '';
  return { userAgent: override || pickUserAgent(fetchCfg, callerUA) };
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

    const content = await fetchSubscription(url, uaOptions(req, userAgent));
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
    const convertOptions = {};
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
      clog.debug('拉取 UA 已确定', { ua: fetchOpts.userAgent });
      for (let i = 0; i < urls.length; i++) {
        const u = urls[i];
        try {
          clog.debug(`拉取订阅 ${i + 1}/${urls.length}`, { url: logger.safeUrl(u) });
          sources.push(await fetchSubscription(u, fetchOpts));
        } catch (err) {
          // 必须脱敏：订阅地址里的 token 不能进日志
          clog.warn(`拉取订阅 ${i + 1}/${urls.length} 失败`, {
            url: logger.safeUrl(u),
            reason: err.message,
          });
        }
      }
    }

    if (!sources.some(s => s && s.trim())) {
      clog.warn('无法获取任何订阅内容，终止转换', { attempted: urls.length });
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
    const convertOptions = { nodeFilters, excludeKeywords };
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
 * 返回当前用户配置（回退到 default.json）
 */
router.get('/config', (req, res) => {
  res.json(readConfig());
});

/**
 * POST /api/config
 * 保存用户配置 — 仅存储与 default.json 的差异
 */
router.post('/config', (req, res) => {
  try {
    const newConfig = req.body;
    if (!newConfig || !Array.isArray(newConfig.groups)) {
      log.warn('POST /api/config 配置格式无效', {
        hasBody: !!newConfig,
        keys: newConfig ? Object.keys(newConfig) : null,
      });
      return res.status(400).json({ error: '无效的配置格式' });
    }

    const saved = saveConfig(newConfig);
    log.info('POST /api/config 完成', { groups: newConfig.groups.length });
    res.json({ success: true, config: saved });
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