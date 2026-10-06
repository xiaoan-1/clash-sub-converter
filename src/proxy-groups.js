/**
 * 根据代理节点名称自动生成分组
 * 分组定义从 config/rules/*.json 读取（通过 RuleManager）
 * 地区识别从 config/regions.json 读取关键词（用于区分国内/国际节点）
 */

const fs = require('fs');
const path = require('path');
const { ruleManager, ALWAYS_ON_RULE_ID } = require('./rule-manager');
const logger = require('./logger');

const log = logger.create('groups');

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
  const upperName = String(name || '').toUpperCase();
  return CN_KEYWORDS_UPPER.has(upperName) || [...CN_KEYWORDS_UPPER].some(kw => upperName.includes(kw));
}

/**
 * 归一化排除关键词：去空白 → 转大写 → 丢弃空串。
 * 空串是任意字符串的子串，若不剔除，一条误配置的关键词就会把全部节点排除干净。
 * @param {Array} keywords
 * @returns {string[]}
 */
function normalizeExcludeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .map(k => String(k).trim().toUpperCase())
    .filter(Boolean);
}

/**
 * 按关键词排除节点。
 * 幂等：传入原始关键词列表或已归一化的列表均可，空列表 = 不过滤。
 * @param {Array} proxies
 * @param {Array} keywords
 */
function filterByExcludeKeywords(proxies, keywords) {
  const upperKeywords = normalizeExcludeKeywords(keywords);
  if (!upperKeywords.length) return proxies;
  return proxies.filter(p => {
    const upper = String(p.name || '').toUpperCase();
    return !upperKeywords.some(kw => upper.includes(kw));
  });
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
  const filteredProxies = filterByExcludeKeywords(proxies, excludeKeywords);

  if (filteredProxies.length !== proxies.length) {
    log.info('关键词排除生效', {
      in: proxies.length,
      out: filteredProxies.length,
      keywords: excludeKeywords.length,
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
    log.warn('hideDomestic 与 hideInternational 同时开启，已忽略这两项过滤');
  } else if (hideDomestic) {
    activeProxies = activeProxies.filter(n => !domesticProxies.has(n));
  } else if (hideInternational) {
    activeProxies = activeProxies.filter(n => domesticProxies.has(n));
  }

  // 注意：到这里节点已经过 applyNodeFilters 过滤，所以下面的开关通常都是默认的 false。
  // 这里只做「分类」，记录国内 / 国际节点各多少，便于对照分组为何出现或消失。
  log.debug('节点分类', {
    total: proxyNames.length,
    domestic: domesticProxies.size,
    active: activeProxies.length,
    hideDomestic,
    hideInternational,
  });

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
  //    正常情况只用非国内节点测速；hideInternational 时所有节点都是国内节点，照常测速。
  //    该分组被「🚀 节点选择」和所有规则分组引用，因此无论如何都要创建 ——
  //    一旦缺失，mihomo 会因 proxy not found 拒绝加载整份配置。
  const autoProxies = hideInternational
    ? activeProxies
    : activeProxies.filter(n => !domesticProxies.has(n));
  // 无非国内节点（如订阅里全是国内节点）时退化为全部活跃节点；再没有就只能直连
  const autoTargets = autoProxies.length ? autoProxies
    : (activeProxies.length ? activeProxies : ['DIRECT']);
  groups.push({
    name: '♻️ 自动选择',
    type: 'url-test',
    url: 'http://www.gstatic.com/generate_204',
    interval: 300,
    tolerance: 50,
    proxies: autoTargets
  });

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
  //    每个规则分组 = defaultProxy 排头 + 其余两个固定选项(节点选择/自动选择/DIRECT 三选二) + 所有活跃节点
  //    Clash 以 proxies 列表的第一个为默认出口
  const fixedOptions = ['🚀 节点选择', '♻️ 自动选择', 'DIRECT'];
  for (const rc of ruleManager.getAll()) {
    if (rc.id === ALWAYS_ON_RULE_ID) continue;

    const ruleCfg = ruleMap.get(rc.id);
    if (ruleCfg && ruleCfg.enabled === false) {
      log.debug('规则分组被用户关闭，跳过', { id: rc.id, name: rc.name });
      continue;
    }

    const defProxy = ruleCfg?.defaultProxy || '♻️ 自动选择';
    const otherOptions = fixedOptions.filter(o => o !== defProxy);

    groups.push({
      name: ruleCfg?.name || rc.name,
      type: ruleCfg?.type || rc.type || 'select',
      proxies: [defProxy, ...otherOptions, ...activeProxies],
      defaultProxy: defProxy
    });
  }

  // 5. 🐟 漏网之鱼（必须，不可禁用）
  groups.push({
    name: '🐟 漏网之鱼',
    type: 'select',
    proxies: ['🚀 节点选择', 'DIRECT', ...activeProxies]
  });

  log.info('分组生成完成', {
    groups: groups.length,
    list: groups.map(g => `${g.name}(${g.type},${g.proxies.length})`),
  });

  return sanitizeGroupRefs(groups, activeProxies);
}

/** 内核内置的代理名，无需在 groups 中定义 */
const BUILTIN_PROXIES = new Set(['DIRECT', 'REJECT', 'PASS', 'GLOBAL']);

/**
 * 移除对不存在分组的引用，并保证每个分组至少有一项。
 *
 * mihomo 遇到 `proxy not found` 或空分组会拒绝加载整份配置，
 * 宁可牺牲个别条目，也要保证输出始终能被客户端加载。
 *
 * @param {Array} groups
 * @param {string[]} [proxyNames] 实际存在的节点名（引用节点是合法的，不能误删）
 * @returns {Array} 同一个数组（就地修正）
 */
function sanitizeGroupRefs(groups, proxyNames = []) {
  const valid = new Set([
    ...groups.map(g => g.name),
    ...BUILTIN_PROXIES,
    ...proxyNames,
  ]);

  for (const group of groups) {
    if (!Array.isArray(group.proxies)) continue;

    const kept = group.proxies.filter(p => valid.has(p));
    if (kept.length !== group.proxies.length) {
      const removed = group.proxies.filter(p => !valid.has(p));
      log.warn('分组中包含不存在的引用，已移除', {
        group: group.name,
        removed: removed.length,
        sample: removed.slice(0, 5),
      });
    }
    // 空分组同样会被内核拒绝，兜底为直连
    group.proxies = kept.length ? kept : ['DIRECT'];
  }
  return groups;
}

module.exports = {
  generateProxyGroups,
  isDomestic,
  normalizeExcludeKeywords,
  filterByExcludeKeywords,
  sanitizeGroupRefs,
  CN_LABEL
};
