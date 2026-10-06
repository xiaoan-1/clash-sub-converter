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

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'default.json');

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
 * 读取合并后的完整配置
 */
function readConfig() {
  const def = loadDefaultConfig();
  const user = loadUserConfig();

  // 合并：default 分组 + 用户覆盖
  const overrides = user.groupOverrides || {};
  const groups = (def.groups || []).map(dg => {
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
  const defGroupMap = {};
  (def.groups || []).forEach(g => {
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
