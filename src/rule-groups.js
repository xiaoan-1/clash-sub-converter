/**
 * 规则组 include/exclude 匹配
 *
 * OpenClash 通过 `include` / `exclude` 正则控制启用哪些规则分组。
 * 别名定义在 `config/rules/*.json` 的 `aliases` 字段里（配置驱动），
 * 新增/修改规则组时改配置即可，无需改代码。
 */
const { ruleManager, ALWAYS_ON_RULE_ID } = require('./rule-manager');

/**
 * 规则组别名映射（OpenClash include/exclude 匹配用）
 *
 * @returns {Object<string, string[]>} 规则 id -> 额外别名
 */
function ruleGroupAliases() {
  const map = {};
  for (const r of ruleManager.getAll()) {
    if (r.id === ALWAYS_ON_RULE_ID) continue;
    if (Array.isArray(r.aliases) && r.aliases.length) map[r.id] = r.aliases;
  }
  return map;
}

/**
 * 取所有可被 include/exclude 控制的规则组 id。
 * ALWAYS_ON_RULE_ID 不是可选分组（其 target 为 DIRECT）且始终启用，因此排除。
 * 直接从规则目录推导，新增规则文件无需再同步别名表。
 * user-config.js 也用它来判断某规则是否属于可选分组（补全前端分组清单）。
 */
function ruleGroupKeys() {
  return ruleManager.getAll()
    .map(r => r.id)
    .filter(id => id !== ALWAYS_ON_RULE_ID);
}

/**
 * 字面量退化匹配时，允许「别名包含该片段」的最短片段长度。
 * 切词后可能留下单字符残片（例如畸形串 netfli|x 里的 x），
 * 限制长度可避免它命中 pixiv 这类含该字符的别名。
 */
const MIN_FRAGMENT_LEN = 3;

/**
 * 正则模式匹配规则组
 *
 * include/exclude 由 OpenClash 透传，绝大多数是合法正则，走 try 分支。
 * 少数用户会填出无法编译的串，此时退化为字面量猜测。
 *
 * @param {string} pattern  include/exclude 正则
 * @param {string} groupKey 规则组 id
 * @param {Object} [aliases] 规则 id -> 别名数组（批量匹配时传入，避免重复构建）
 */
function patternMatchGroup(pattern, groupKey, aliases) {
  if (!pattern) return false;
  const clean = pattern.replace(/^\(\?i\)/, '').trim();
  // 去掉 (?i) 后为空的模式（如 OpenClash 发了 `(?i)`）不能匹配任何分组：
  // new RegExp('') 匹配任意字符串，会把全部规则组静默打开/关闭。
  if (!clean) return false;
  const aliasMap = aliases || ruleGroupAliases();
  // 自身 id 始终作为候选：别名表若漏写自身 id，该组会静默失效（本次修过的同类 bug）
  const candidates = [groupKey, ...(aliasMap[groupKey] || [])];
  try {
    const re = new RegExp(clean, 'i');
    return candidates.some(a => re.test(a));
  } catch {
    // 非法正则：退化为字面量匹配，但必须先按分隔符切词，不能对整串做子串匹配。
    // 原实现是双向子串（别名含原文 || 原文含别名），反向那一支没有词边界，
    // 两三个字母的别名会命中毫不相干的词：
    //   confirm[ → nf → netflix      high[ / weight[ → gh → github
    //   pixel[   → pix → pixiv
    // 于是 exclude 会静默关掉用户根本没提过的整组规则；同时反向还会漏掉
    // (?i)steam[ 这种「别名含原文」本应命中的情况（原文尾部粘着 [ 导致整串匹配失败）。
    // 切词后：整词相等一律认；「别名包含该片段」限制在 >= MIN_FRAGMENT_LEN。
    const tokens = clean.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    return tokens.some(t => candidates.some(a => {
      const alias = a.toLowerCase();
      return alias === t || (t.length >= MIN_FRAGMENT_LEN && alias.includes(t));
    }));
  }
}

/**
 * 解析 OpenClash 发送的 include/exclude 正则，映射到内部规则组
 */
function parseRuleOptions(include, exclude) {
  const ruleKeys = ruleGroupKeys();
  const ruleOptions = {};

  // 别名表只构建一次，供本次全部匹配复用
  const aliases = ruleGroupAliases();

  // 默认全部启用
  for (const key of ruleKeys) ruleOptions[key] = true;

  // include: 先全部禁用，只启用匹配的
  if (include) {
    for (const key of ruleKeys) ruleOptions[key] = false;
    for (const key of ruleKeys) {
      if (patternMatchGroup(include, key, aliases)) ruleOptions[key] = true;
    }
  }

  // exclude: 排除匹配的
  if (exclude) {
    for (const key of ruleKeys) {
      if (patternMatchGroup(exclude, key, aliases)) ruleOptions[key] = false;
    }
  }

  return ruleOptions;
}

module.exports = {
  ruleGroupAliases,
  ruleGroupKeys,
  patternMatchGroup,
  parseRuleOptions,
};
