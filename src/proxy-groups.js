/**
 * 根据代理节点名称自动生成分组
 * 分组定义从 config/rules/*.json 读取（通过 RuleManager）
 * 地区识别从 config/regions.json 读取关键词（用于区分国内/国际节点）
 */

const fs = require('fs');
const path = require('path');
const { ruleManager } = require('./rule-manager');

// 加载地区配置
const regionsPath = path.join(__dirname, '..', 'config', 'regions.json');
const regionsConfig = JSON.parse(fs.readFileSync(regionsPath, 'utf8'));
const CN_LABEL = regionsConfig.domestic.label; // '🇨🇳 中国大陆'

// 预计算国内关键词
const CN_KEYWORDS_UPPER = new Set(regionsConfig.domestic.keywords.map(k => k.toUpperCase()));

/**
 * 根据节点名称判断是否为国内节点
 */
function isDomestic(name) {
  const upperName = name.toUpperCase();
  return CN_KEYWORDS_UPPER.has(upperName) || [...CN_KEYWORDS_UPPER].some(kw => upperName.includes(kw));
}

/**
 * 生成代理分组配置
 * @param {Array} proxies - 代理节点数组
 * @param {Object} options
 * @param {Array} options.userGroups - 用户分组配置（来自 config.json）
 * @param {Object} options.nodeFilters - { hideDomestic, hideInternational }
 * @param {Array} options.excludeKeywords - 排除关键词列表
 */
function generateProxyGroups(proxies, options = {}) {
  const { userGroups = [], nodeFilters = {}, excludeKeywords = [] } = options;
  const { hideDomestic = false, hideInternational = false } = nodeFilters;

  // 0. 关键词排除（在所有分类前执行）
  let filteredProxies = proxies;
  if (excludeKeywords.length > 0) {
    const upperKeywords = excludeKeywords.map(k => k.toUpperCase());
    filteredProxies = proxies.filter(p => {
      const upper = p.name.toUpperCase();
      return !upperKeywords.some(kw => upper.includes(kw));
    });
  }

  const proxyNames = filteredProxies.map(p => p.name);

  // 分类节点
  const domesticProxies = new Set();
  for (const proxy of filteredProxies) {
    if (isDomestic(proxy.name)) domesticProxies.add(proxy.name);
  }

  // 应用全局过滤（两个同时开启 = 无意义，回退为不过滤）
  let activeProxies = proxyNames;
  if (hideDomestic && hideInternational) {
    // 两个互斥开关同时开，忽略过滤
  } else if (hideDomestic) {
    activeProxies = activeProxies.filter(n => !domesticProxies.has(n));
  } else if (hideInternational) {
    activeProxies = activeProxies.filter(n => domesticProxies.has(n));
  }

  // 用户配置查找表
  const builtinMap = new Map();  // builtin -> config
  const ruleMap = new Map();     // ruleId -> config
  for (const ug of userGroups) {
    if (ug.builtin) builtinMap.set(ug.builtin, ug);
    else if (ug.ruleId) ruleMap.set(ug.ruleId, ug);
  }

  const groups = [];

  // 1. 🚀 节点选择（必须，不可禁用）
  groups.push({
    name: '🚀 节点选择',
    type: 'select',
    proxies: ['♻️ 自动选择', 'DIRECT', ...activeProxies]
  });

  // 2. ♻️ 自动选择（必须，不可禁用）
  //    正常情况只用非国内节点测速；hideInternational 时所有节点都是国内节点，照常测速
  const autoProxies = hideInternational
    ? activeProxies
    : activeProxies.filter(n => !domesticProxies.has(n));
  if (autoProxies.length > 0) {
    groups.push({
      name: '♻️ 自动选择',
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: autoProxies
    });
  }

  // 3. 🇨🇳 中国大陆（可选，仅在有国内节点且未隐藏时出现）
  if (!hideDomestic && domesticProxies.size > 0) {
    const domesticCfg = builtinMap.get('domestic');
    if (!domesticCfg || domesticCfg.enabled !== false) {
      groups.push({
        name: CN_LABEL,
        type: 'select',
        proxies: ['DIRECT', ...domesticProxies]
      });
    }
  }

  // 4. 规则分组（可选，默认开）
  //    每个规则分组 = DIRECT + ♻️ 自动选择 + 所有活跃节点
  for (const rc of ruleManager.getAll()) {
    if (rc.id === 'common') continue;

    const ruleCfg = ruleMap.get(rc.id);
    if (ruleCfg && ruleCfg.enabled === false) continue;

    groups.push({
      name: ruleCfg?.name || rc.name,
      type: ruleCfg?.type || rc.type || 'select',
      proxies: ['DIRECT', '♻️ 自动选择', ...activeProxies],
      defaultProxy: ruleCfg?.defaultProxy
    });
  }

  // 5. 🐟 漏网之鱼（必须，不可禁用）
  groups.push({
    name: '🐟 漏网之鱼',
    type: 'select',
    proxies: ['🚀 节点选择', 'DIRECT', ...activeProxies]
  });

  return groups;
}

module.exports = {
  generateProxyGroups,
  isDomestic,
  CN_LABEL
};
