const crypto = require('crypto');

/**
 * Base64 解码
 */
function base64Decode(str) {
  // 处理 URL 安全的 Base64
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  // 补齐 padding
  const padding = str.length % 4;
  if (padding) str += '='.repeat(4 - padding);
  return Buffer.from(str, 'base64').toString('utf-8');
}

/**
 * Base64 编码
 */
function base64Encode(str) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

/**
 * 生成 UUID
 */
function generateUUID() {
  return crypto.randomUUID();
}

/**
 * 解析 URL 参数
 */
function parseUrlParams(urlStr) {
  try {
    const url = new URL(urlStr);
    const params = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    return params;
  } catch {
    return {};
  }
}

/**
 * 判断是否为分隔线节点（用于标记分组）
 */
function isSeparator(name) {
  return /^-{3,}/.test(name) || /^={3,}/.test(name);
}

/**
 * 延迟函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 安全的 JSON 解析
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * 远程获取订阅内容
 */
async function fetchSubscription(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ClashForAndroid/2.5.12', 'Accept': '*/*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

/**
 * 规则组别名映射（OpenClash include/exclude 匹配用）
 */
const RULE_GROUP_ALIASES = {
  telegram: ['telegram', 'tg'],
  openai:   ['openai', 'chatgpt', 'gpt'],
  claude:   ['claude', 'anthropic'],
  gemini:   ['gemini', 'bard', 'google ai', 'deepmind'],
  youtube:  ['youtube', 'ytb'],
  netflix:  ['netflix', 'nf'],
  disney:   ['disney', 'disneyplus'],
  dazn:     ['dazn'],
  bahamut:  ['bahamut'],
  bilibili: ['bilibili', 'bili'],
  github:   ['github', 'gh'],
  mihoyo:   ['mihoyo', 'hoyoverse'],
};

/**
 * 正则模式匹配规则组
 */
function patternMatchGroup(pattern, groupKey) {
  if (!pattern) return false;
  const clean = pattern.replace(/^\(\?i\)/, '');
  const aliases = RULE_GROUP_ALIASES[groupKey] || [groupKey];
  try {
    const re = new RegExp(clean, 'i');
    return aliases.some(a => re.test(a));
  } catch {
    const lower = clean.toLowerCase();
    return aliases.some(a => a.includes(lower) || lower.includes(a));
  }
}

/**
 * 解析 OpenClash 发送的 include/exclude 正则，映射到内部规则组
 */
function parseRuleOptions(include, exclude) {
  const ruleKeys = Object.keys(RULE_GROUP_ALIASES);
  const ruleOptions = {};

  // 默认全部启用
  for (const key of ruleKeys) ruleOptions[key] = true;

  // include: 先全部禁用，只启用匹配的
  if (include) {
    for (const key of ruleKeys) ruleOptions[key] = false;
    for (const key of ruleKeys) {
      if (patternMatchGroup(include, key)) ruleOptions[key] = true;
    }
  }

  // exclude: 排除匹配的
  if (exclude) {
    for (const key of ruleKeys) {
      if (patternMatchGroup(exclude, key)) ruleOptions[key] = false;
    }
  }

  return ruleOptions;
}

module.exports = {
  base64Decode,
  base64Encode,
  generateUUID,
  parseUrlParams,
  isSeparator,
  sleep,
  safeJsonParse,
  fetchSubscription,
  RULE_GROUP_ALIASES,
  patternMatchGroup,
  parseRuleOptions
};
