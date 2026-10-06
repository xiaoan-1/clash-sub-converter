const express = require('express');
const { fetchSubscription } = require('./utils');
const { readConfig, saveConfig } = require('./user-config');
const { listPresets, pickUserAgent } = require('./user-agents');
const { parseSubscription, extractClashDns } = require('./parser');
const { isDomestic, CN_LABEL } = require('./proxy-groups');
const { ruleManager } = require('./rule-manager');
const { convertToClash } = require('./converter');

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

// ===================== 订阅解析 =====================

/**
 * POST /api/parse
 * 请求体: { url: "订阅地址" }
 * 返回: { nodes: [{ name, type, region }, ...] }
 */
router.post('/parse', async (req, res) => {
  try {
    const { url, userAgent } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });

    const content = await fetchSubscription(url, uaOptions(req, userAgent));
    const proxies = parseSubscription(content);

    const nodes = proxies.map(p => ({
      name: p.name,
      type: p.type,
      region: isDomestic(p.name) ? CN_LABEL : '🌐 其他',
    }));

    res.json({ nodes, total: nodes.length });
  } catch (err) {
    console.error('[api/parse]', err.message);
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
    if (!content || !content.trim()) {
      return res.status(400).json({ error: '缺少文件内容' });
    }

    const proxies = parseSubscription(content);
    if (proxies.length === 0) {
      return res.status(400).json({ error: '未找到有效代理节点' });
    }

    // 源订阅若自带 Clash DNS 配置则透传，保证与直接导入等价
    const convertOptions = {};
    const srcDns = extractClashDns(content);
    if (srcDns) convertOptions.dns = srcDns;

    const result = convertToClash(proxies, convertOptions);
    res.json({ yaml: result.yaml, count: proxies.length });
  } catch (err) {
    console.error('[api/convert-file]', err.message);
    res.status(500).json({ error: '转换失败: ' + err.message });
  }
});

// ===================== 完整转换（支持多URL + 过滤参数） =====================

/**
 * POST /api/convert
 * 请求体: { urls: ["url1","url2"], nodeFilter: "all|hideDomestic|hideInternational", excludeKeywords: ["关键词"] }
 * 返回: { yaml, summary: { totalNodes, filteredNodes, groups: [{name, type, proxies}] } }
 */
router.post('/convert', async (req, res) => {
  try {
    const { urls = [], nodeFilter = 'all', excludeKeywords = [], rawContent, userAgent } = req.body;

    let allContent = '';

    // 支持两种来源：URL 或直接内容（文件上传）
    if (rawContent && rawContent.trim()) {
      allContent = rawContent;
    } else {
      if (!urls.length) {
        return res.status(400).json({ error: '缺少订阅链接' });
      }
      const fetchOpts = uaOptions(req, userAgent);
      for (const u of urls) {
        try {
          const text = await fetchSubscription(u, fetchOpts);
          allContent += (allContent ? '\n' : '') + text;
        } catch (err) {
          console.warn(`[api/convert] 获取失败: ${u} - ${err.message}`);
        }
      }
    }

    if (!allContent) {
      return res.status(400).json({ error: '无法获取任何订阅内容' });
    }

    const proxies = parseSubscription(allContent);
    if (proxies.length === 0) {
      return res.status(400).json({ error: '未找到有效代理节点' });
    }

    // 构建过滤参数
    const nodeFilters = {
      hideDomestic: nodeFilter === 'hideDomestic',
      hideInternational: nodeFilter === 'hideInternational'
    };

    // 源订阅若自带 Clash DNS 配置则透传，保证与直接导入等价
    const srcDns = extractClashDns(allContent);
    const convertOptions = { nodeFilters, excludeKeywords };
    if (srcDns) convertOptions.dns = srcDns;

    const result = convertToClash(proxies, convertOptions);
    res.json({
      yaml: result.yaml,
      summary: result.summary
    });
  } catch (err) {
    console.error('[api/convert]', err.message);
    res.status(500).json({ error: '转换失败: ' + err.message });
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
      return res.status(400).json({ error: '无效的配置格式' });
    }

    const saved = saveConfig(newConfig);
    res.json({ success: true, config: saved });
  } catch (err) {
    console.error('[api/config]', err.message);
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