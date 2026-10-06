/**
 * 用户配置读写
 *
 * 结构约定
 * --------
 *   config/default.json —— 基准，含全部内置分组定义（纳入版本控制）
 *   config.json         —— 用户配置，位于项目根目录，仅存与基准的差异
 *                          （被 .gitignore 忽略）
 *
 * readConfig() 返回「基准 + 用户覆盖」合并后的完整配置，供 index.js / api.js / converter.js 共用。
 */

const fs = require('fs');
const path = require('path');
const { ruleManager } = require('./rule-manager');
const { ruleGroupKeys } = require('./utils');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'default.json');

/**
 * 规则分组未在 default.json 里时的兜底默认出口。
 * 必须与 proxy-groups.js 的 `ruleCfg?.defaultProxy || '♻️ 自动选择'` 一致，
 * 否则前端下拉框显示的默认出口与后端实际生成的分组不符。
 */
const DEFAULT_RULE_PROXY = '♻️ 自动选择';

/**
 * 加载 default.json 作为基准
 */
function loadDefaultConfig() {
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
  } catch {
    return { subscriptions: [], groups: [], nodeFilters: {}, excludeKeywords: [], fetch: {} };
  }
}

/**
 * 读取用户 config.json（不存在或损坏时返回空对象）
 */
function loadUserConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * 补全 default.json 里缺失的规则分组。
 *
 * 分组有两个各自硬编码的来源：
 *   config/rules/*.json —— proxy-groups 由它推导，决定 Clash 输出里有哪些分组
 *   config/default.json —— 前端分组列表由它推导，决定用户能配置哪些分组
 * 新增一个规则文件不会自动出现在 default.json 里。于是经 POST /api/rules
 * 新增规则后，Clash 输出多出了该分组，配置界面却看不到它：用户无法禁用、
 * 无法改默认出口、无法改类型，保存时还会被 saveConfig 静默跳过
 * （user-config.js: `const dg = defGroupMap[key]; if (!dg) return;`）。
 *
 * 以规则目录为准补全缺失项，默认值与 proxy-groups.js 的分支保持一致：
 *   name      = ruleCfg?.name || rc.name
 *   type      = ruleCfg?.type || rc.type || 'select'
 *   defaultProxy = ruleCfg?.defaultProxy || '♻️ 自动选择'
 *
 * @param {Array} baseGroups default.json 里的 groups
 * @returns {Array} 需要补充分组
 */
function missingRuleGroups(baseGroups) {
  const known = new Set();
  for (const g of baseGroups) {
    const key = g.ruleId || g.builtin;
    if (key) known.add(key);
  }

  const extra = [];
  for (const id of ruleGroupKeys()) {
    if (known.has(id)) continue;
    const rc = ruleManager.getById(id);
    if (!rc) continue;
    extra.push({
      ruleId: id,
      name: rc.name,
      type: rc.type || 'select',
      enabled: true,
      defaultProxy: DEFAULT_RULE_PROXY,
    });
  }
  return extra;
}

/**
 * 生效的分组基准 = default.json 的 groups + 规则目录补全。
 * readConfig 与 saveConfig 必须用同一份基准，否则补充分组的修改存不下来。
 */
function effectiveGroups(def) {
  const base = def.groups || [];
  return [...base, ...missingRuleGroups(base)];
}

/**
 * 读取合并后的完整配置
 */
function readConfig() {
  const def = loadDefaultConfig();
  const user = loadUserConfig();

  // 合并：default 分组 + 规则目录补全 + 用户覆盖
  const overrides = user.groupOverrides || {};
  const groups = effectiveGroups(def).map(dg => {
    const key = dg.ruleId || dg.builtin;
    const ov = overrides[key] || {};
    return {
      ...dg,
      ...ov,
      enabled: ov.enabled !== undefined ? ov.enabled : (dg.enabled !== false),
    };
  });

  return {
    subscriptions: user.subscriptions || [],
    nodeFilters: user.nodeFilters || def.nodeFilters || {},
    excludeKeywords: user.excludeKeywords || def.excludeKeywords || [],
    fetch: { ...(def.fetch || {}), ...(user.fetch || {}) },
    groups,
  };
}

/**
 * 保存用户配置 —— 仅存与 default.json 的差异
 * @returns {Object} 实际写入的配置
 */
function saveConfig(newConfig) {
  const def = loadDefaultConfig();

  // ---- 分组覆盖 ----
  // 基准含规则目录补全项，否则用户在界面上对补充分组的修改会被静默丢弃
  const defGroupMap = {};
  effectiveGroups(def).forEach(g => {
    const key = g.ruleId || g.builtin;
    if (key) defGroupMap[key] = g;
  });

  const groupOverrides = {};
  (newConfig.groups || []).forEach(g => {
    const key = g.ruleId || g.builtin;
    const dg = defGroupMap[key];
    if (!dg) return;

    const ov = {};
    const defEnabled = dg.enabled !== false;
    if (g.enabled !== undefined && g.enabled !== defEnabled) ov.enabled = g.enabled;
    if (g.type !== undefined && g.type !== dg.type) ov.type = g.type;
    if (g.defaultProxy !== undefined && g.defaultProxy !== dg.defaultProxy) ov.defaultProxy = g.defaultProxy;
    if (Object.keys(ov).length > 0) groupOverrides[key] = ov;
  });

  // ---- 拉取设置覆盖 ----
  const defFetch = def.fetch || {};
  const newFetch = newConfig.fetch || {};
  const fetchOv = {};
  for (const k of ['userAgent', 'customUserAgent']) {
    if (newFetch[k] !== undefined && newFetch[k] !== defFetch[k]) fetchOv[k] = newFetch[k];
  }

  const out = {
    subscriptions: newConfig.subscriptions || [],
    nodeFilters: newConfig.nodeFilters || def.nodeFilters || {},
    excludeKeywords: newConfig.excludeKeywords || [],
    groupOverrides,
  };
  if (Object.keys(fetchOv).length > 0) out.fetch = fetchOv;

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf-8');
  return out;
}

module.exports = {
  CONFIG_PATH,
  DEFAULT_CONFIG_PATH,
  loadDefaultConfig,
  loadUserConfig,
  readConfig,
  saveConfig,
};
