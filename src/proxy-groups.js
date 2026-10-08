/**
 * 根据代理节点名称自动生成分组
 * 分组定义从 config/rules/*.json 读取（通过 RuleManager）
 * 地区识别从 config/regions.json 读取关键词（区分国内/国际节点，并生成地区分组）
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

/**
 * 构建关键词匹配器。
 *
 * 短 ASCII 词（CN / IN / US / HK …）必须按「词边界」匹配：子串匹配会让
 * `CN` 命中 `CN2 GIA`、`IN` 命中 `KINX`，把大量国际节点误判成国内节点。
 * 中文与较长词不存在词边界问题，直接子串匹配即可。
 *
 * @param {string[]} keywords
 * @returns {(upperName:string)=>boolean} 传入已转大写的节点名
 */
function buildMatcher(keywords) {
  const ascii = [];
  const plain = [];
  for (const raw of keywords || []) {
    const kw = String(raw).toUpperCase().trim();
    if (!kw) continue;
    if (/^[A-Z0-9]+$/.test(kw) && kw.length <= 3) ascii.push(kw);
    else plain.push(kw);
  }
  // 预编译词边界正则：短词前后不能是字母或数字
  const asciiRe = ascii.length
    ? new RegExp(`(^|[^A-Z0-9])(${ascii.join('|')})([^A-Z0-9]|$)`)
    : null;
  return (upper) => {
    if (asciiRe && asciiRe.test(upper)) return true;
    return plain.some(kw => upper.includes(kw));
  };
}

// 预计算匹配器（只构建一次，避免每次调用都展开关键词数组）
const DOMESTIC_MATCH = buildMatcher(regionsConfig.domestic.keywords);
const REGION_MATCHERS = Object.entries(regionsConfig.regions || {}).map(([label, keywords]) => ({
  label,
  match: buildMatcher(keywords),
}));

/**
 * 根据节点名称识别所属地区。
 *
 * 必须先匹配具体地区、再判断国内：「[台湾省] 中华电信」同时含「台湾」（地区）
 * 与「电信」（国内关键词），若先判国内就会把台湾节点误判成国内节点。
 *
 * @returns {string|null} 地区标签（如 '🇭🇰 香港'）、CN_LABEL，或 null（无法识别）
 */
function getRegion(name) {
  const upper = String(name || '').toUpperCase();
  if (!upper) return null;
  // 1. 先匹配具体地区：命中即视为国际节点
  for (const r of REGION_MATCHERS) {
    if (r.match(upper)) return r.label;
  }
  // 2. 再看是否国内
  if (DOMESTIC_MATCH(upper)) return CN_LABEL;
  return null;
}

/**
 * 根据节点名称判断是否为国内节点
 */
function isDomestic(name) {
  return getRegion(name) === CN_LABEL;
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
 *
 * 注意：传入的 proxies 应已由调用方（converter.js → applyNodeFilters）完成
 * 关键词与国内/国际过滤。此处只负责「分类与组装」，不再重复过滤 ——
 * 两处各过滤一遍必然分叉，过滤只保留在 applyNodeFilters 一处。
 *
 * @param {Array} proxies - 已过滤的代理节点数组
 * @param {Object} options
 * @param {Array} options.userGroups - 用户分组配置（来自 config.json）
 */
function generateProxyGroups(proxies, options = {}) {
  const { userGroups = [] } = options;

  const activeProxies = proxies.map(p => p.name);

  // 分类节点：国内 / 国际
  const domesticProxies = new Set();
  for (const proxy of proxies) {
    if (isDomestic(proxy.name)) domesticProxies.add(proxy.name);
  }

  log.debug('节点分类', {
    total: activeProxies.length,
    domestic: domesticProxies.size,
    international: activeProxies.length - domesticProxies.size,
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
  //    只对非国内节点测速：国内节点走直连更合适，参与测速会让自动选择偏向国内。
  //    该分组被「🚀 节点选择」和所有规则分组引用，因此无论如何都要创建 ——
  //    一旦缺失，mihomo 会因 proxy not found 拒绝加载整份配置。
  const autoProxies = activeProxies.filter(n => !domesticProxies.has(n));
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

  // 3. 🇨🇳 中国大陆（可选，仅在有国内节点时出现）
  if (domesticProxies.size > 0) {
    const domesticCfg = builtinMap.get('domestic');
    if (!domesticCfg || domesticCfg.enabled !== false) {
      groups.push({
        name: CN_LABEL,
        type: 'select',
        proxies: ['DIRECT', ...domesticProxies]
      });
    }
  }

  // 4. 地区分组（可选，默认开）：按地区标签归类，只对出现过的地区建组
  const regionsCfg = builtinMap.get('regions');
  const regionsEnabled = !regionsCfg || regionsCfg.enabled !== false;
  if (regionsEnabled) {
    const regionMap = new Map(); // 地区标签 -> 节点名列表
    for (const name of activeProxies) {
      const region = getRegion(name);
      // 国内节点由「🇨🇳 中国大陆」统一承载，不再单独建组
      if (!region || region === CN_LABEL) continue;
      if (!regionMap.has(region)) regionMap.set(region, []);
      regionMap.get(region).push(name);
    }
    for (const [label, names] of regionMap) {
      groups.push({
        name: label,
        type: 'url-test',
        url: 'http://www.gstatic.com/generate_204',
        interval: 300,
        tolerance: 50,
        proxies: names
      });
    }
    if (regionMap.size) {
      log.debug('地区分组生成', { regions: regionMap.size, list: [...regionMap.keys()] });
    }
  }

  // 5. 规则分组（可选，默认开）
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

  // 6. 🐟 漏网之鱼（必须，不可禁用）
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
  getRegion,
  normalizeExcludeKeywords,
  filterByExcludeKeywords,
  sanitizeGroupRefs,
  CN_LABEL
};
