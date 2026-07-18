const express = require('express');
const fs = require('fs');
const path = require('path');
const { fetchSubscription } = require('./utils');
const { parseSubscription } = require('./parser');
const { isDomestic, CN_LABEL } = require('./proxy-groups');
const { ruleManager } = require('./rule-manager');
const { convertToClash } = require('./converter');

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

// ===================== 工具函数 =====================

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return { subscriptions: [], groups: [] };
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * 生成默认的用户分组配置（包含所有类型）
 */
function getDefaultGroupsConfig() {
  const groups = [];

  // 必须分组 - 节点选择（不可禁用）
  groups.push({
    builtin: 'select',
    name: '🚀 节点选择',
    type: 'select',
    defaultProxy: '♻️ 自动选择',
  });

  // 必须分组 - 自动选择（不可禁用）
  groups.push({
    builtin: 'auto',
    name: '♻️ 自动选择',
    type: 'url-test',
    defaultProxy: '♻️ 自动选择',
  });

  // 可选内置分组 - 国内直连
  groups.push({
    builtin: 'domestic',
    name: '🇨🇳 中国大陆',
    type: 'select',
    enabled: true,
    defaultProxy: 'DIRECT',
  });

  // 规则分组（从 ruleManager 生成）
  const directDefaultIds = { apple: true, microsoft: true };
  for (const r of ruleManager.getAll()) {
    if (r.id === 'common') continue;
    groups.push({
      ruleId: r.id,
      name: r.name,
      type: r.type || 'select',
      enabled: true,
      defaultProxy: directDefaultIds[r.id] ? 'DIRECT' : '♻️ 自动选择',
    });
  }

  // 必须分组 - 漏网之鱼（不可禁用）
  groups.push({
    builtin: 'fallback',
    name: '🐟 漏网之鱼',
    type: 'select',
    defaultProxy: '🚀 节点选择',
  });

  return groups;
}

// ===================== 订阅解析 =====================

/**
 * POST /api/parse
 * 请求体: { url: "订阅地址" }
 * 返回: { nodes: [{ name, type, region }, ...] }
 */
router.post('/parse', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: '缺少 url 参数' });

    const content = await fetchSubscription(url);
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

    const result = convertToClash(proxies, {});
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
    const { urls = [], nodeFilter = 'all', excludeKeywords = [], rawContent } = req.body;

    let allContent = '';

    // 支持两种来源：URL 或直接内容（文件上传）
    if (rawContent && rawContent.trim()) {
      allContent = rawContent;
    } else {
      if (!urls.length) {
        return res.status(400).json({ error: '缺少订阅链接' });
      }
      for (const u of urls) {
        try {
          const text = await fetchSubscription(u);
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

    const result = convertToClash(proxies, { nodeFilters, excludeKeywords });
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
 * GET /api/config
 * 返回当前用户配置（如果没有则返回默认配置）
 */
router.get('/config', (req, res) => {
  const config = readConfig();
  // 如果没有分组配置，用规则文件生成默认的
  if (!config.groups || config.groups.length === 0) {
    config.groups = getDefaultGroupsConfig();
  }
  // 确保 nodeFilters 有默认值（默认隐藏国内）
  if (!config.nodeFilters) {
    config.nodeFilters = { hideDomestic: true, hideInternational: false };
  }
  // 确保 excludeKeywords 有默认值（默认全选）
  if (!Array.isArray(config.excludeKeywords) || config.excludeKeywords.length === 0) {
    config.excludeKeywords = [
      '流量', '官网', '套餐', '到期', '剩余', '应急', '免费', '测试',
      '失效', '过期', '活动', '优惠', '推荐', '广告', '回国', '禁止',
      'ipv6', '中转', '隧道', '倍率', '专线', '-----'
    ];
  }
  res.json(config);
});

/**
 * POST /api/config
 * 保存用户配置
 */
router.post('/config', (req, res) => {
  try {
    const config = req.body;
    if (!config || !Array.isArray(config.groups)) {
      return res.status(400).json({ error: '无效的配置格式' });
    }
    writeConfig(config);
    res.json({ success: true });
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
