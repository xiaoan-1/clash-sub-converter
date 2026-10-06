const crypto = require('crypto');
const { pickUserAgent, FALLBACK_UA } = require('./user-agents');

/** 默认 UA（未做任何配置时使用） */
const DEFAULT_FETCH_UA = FALLBACK_UA;

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
 * 读取订阅源响应头。
 *
 * 部分机场为了绕过 CDN / 对象存储的限制，会给头加前缀
 * （如 `x-amz-meta-subscription-userinfo`），因此除了精确匹配
 * 还要兼容 `*-<name>` 形式的变体。
 */
function readSubHeader(headers, name) {
  if (!headers) return '';
  const exact = headers.get(name);
  if (exact) return exact;
  const suffix = '-' + name;
  for (const [key, value] of headers) {
    if (key.toLowerCase().endsWith(suffix)) return value;
  }
  return '';
}

/**
 * 解析 subscription-userinfo 响应头。
 *
 * 机场把订阅的流量与到期信息放在这个头里，形如：
 *   upload=1234; download=5678; total=107374182400; expire=1735660800
 * 缺失的字段不输出；无法解析时返回 null。
 *
 * @returns {{upload?:number,download?:number,total?:number,expire?:number}|null}
 */
function parseUserInfo(value) {
  if (!value) return null;
  const info = {};
  for (const part of String(value).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    if (!['upload', 'download', 'total', 'expire'].includes(key)) continue;
    const num = Number(part.slice(idx + 1).trim());
    if (!Number.isFinite(num) || num < 0) continue;
    info[key] = Math.floor(num);
  }
  return Object.keys(info).length ? info : null;
}

/**
 * 合并多个订阅的流量信息（`url` 用 `|` 合并多份订阅时使用）。
 *
 * upload / download / total 累加；expire 取最早的非 0 到期时间
 * （最早到期的最紧要）。单份订阅时等同于原值透传。
 */
function mergeUserInfo(list) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return null;

  const merged = {};
  for (const key of ['upload', 'download', 'total']) {
    if (items.some(i => typeof i[key] === 'number')) {
      merged[key] = items.reduce(
        (sum, i) => sum + (typeof i[key] === 'number' ? i[key] : 0), 0
      );
    }
  }

  const expires = items
    .map(i => i.expire)
    .filter(v => typeof v === 'number' && v > 0);
  if (expires.length) merged.expire = Math.min(...expires);

  return Object.keys(merged).length ? merged : null;
}

/** 把流量信息序列化回 subscription-userinfo 的格式 */
function formatUserInfo(info) {
  if (!info) return '';
  return ['upload', 'download', 'total', 'expire']
    .filter(k => typeof info[k] === 'number')
    .map(k => `${k}=${info[k]}`)
    .join('; ');
}

/** 校验机场官网地址，仅允许 http(s)，防止把任意值透传给客户端 */
function sanitizeHomeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 解析 profile-update-interval（客户端自动更新间隔，单位小时），限定 1~720 */
function parseUpdateInterval(value) {
  const num = Number(String(value || '').trim());
  if (!Number.isFinite(num) || num <= 0) return '';
  return String(Math.min(Math.floor(num), 720));
}

/**
 * 从 Content-Disposition 取出订阅文件名。
 *
 * Clash Verge 用它作为订阅（profile）的名称，缺失时客户端只能从 URL 猜，
 * 结果往往是 `sub` 这类无意义的名字。
 */
function parseFileName(value) {
  if (!value) return '';
  const matched =
    /filename\*=(?:UTF-8'')?([^;]+)/i.exec(value) ||
    /filename="?([^";]+)"?/i.exec(value);
  if (!matched) return '';

  let name = matched[1].trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // 编码异常时保留原值
  }
  // 去掉路径分隔符 / 引号 / 控制字符，避免头部注入与路径穿越
  return name.replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 100);
}

/** 组装 Content-Disposition，非 ASCII 文件名用 RFC 5987 编码 */
function buildContentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '');
  if (ascii && ascii === fileName) {
    return `attachment; filename="${ascii}"`;
  }
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${ascii || 'subscription.yaml'}"; filename*=UTF-8''${utf8}`;
}

/**
 * 请求订阅源，返回正文与元信息响应头。
 *
 * UA 可配置：机场会校验拉取订阅的客户端标识，若与你的实际客户端不一致，
 * 可能被判定为「非本人操作 / 订阅地址泄漏」而作废订阅地址。
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.userAgent] - 直接指定 UA（优先级最高）
 * @param {Object} [options.fetchCfg]  - 配置中的 fetch 段 { userAgent, customUserAgent }
 * @param {string} [options.callerUA]  - 调用方请求头里的 UA（供 auto 模式透传）
 * @returns {Promise<{text:string,userInfo:Object|null,homeUrl:string,updateInterval:string,fileName:string}>}
 */
async function requestSubscription(url, options = {}) {
  const ua = options.userAgent
    || pickUserAgent(options.fetchCfg || {}, options.callerUA || '')
    || DEFAULT_FETCH_UA;

  const response = await fetch(url, {
    headers: { 'User-Agent': ua, 'Accept': '*/*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const headers = response.headers;
  return {
    text: await response.text(),
    userInfo: parseUserInfo(readSubHeader(headers, 'subscription-userinfo')),
    homeUrl: sanitizeHomeUrl(readSubHeader(headers, 'profile-web-page-url')),
    updateInterval: parseUpdateInterval(readSubHeader(headers, 'profile-update-interval')),
    fileName: parseFileName(readSubHeader(headers, 'content-disposition'))
  };
}

/** 只需订阅正文时的便捷包装 */
async function fetchSubscription(url, options = {}) {
  return (await requestSubscription(url, options)).text;
}

/**
 * 把订阅源下发的元信息响应头转发给客户端。
 *
 * Clash / Clash Verge / ClashX 等客户端靠这些头展示订阅流量、到期时间、
 * 官网入口与自动更新间隔。转换器若只转发 YAML 正文，这些信息会全部丢失，
 * 客户端面板上的订阅详情就是空白。
 *
 * @param {import('express').Response} res
 * @param {Array} metas - requestSubscription 的返回值列表
 */
function applySubscriptionHeaders(res, metas) {
  const list = (metas || []).filter(Boolean);
  if (!list.length) return;

  const userInfo = mergeUserInfo(list.map(m => m.userInfo));
  if (userInfo) res.setHeader('subscription-userinfo', formatUserInfo(userInfo));

  const homeUrl = list.map(m => m.homeUrl).find(Boolean);
  if (homeUrl) res.setHeader('profile-web-page-url', homeUrl);

  const interval = list.map(m => m.updateInterval).find(Boolean);
  if (interval) res.setHeader('profile-update-interval', interval);

  const fileName = list.map(m => m.fileName).find(Boolean);
  if (fileName) {
    try {
      res.setHeader('Content-Disposition', buildContentDisposition(fileName));
    } catch {
      // 文件名含响应头不支持的字符时跳过，不影响正文
    }
  }
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
  requestSubscription,
  applySubscriptionHeaders,
  parseUserInfo,
  mergeUserInfo,
  formatUserInfo,
  DEFAULT_FETCH_UA,
  RULE_GROUP_ALIASES,
  patternMatchGroup,
  parseRuleOptions
};
