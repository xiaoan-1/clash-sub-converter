/**
 * 订阅拉取的 User-Agent 预设
 *
 * 背景
 * ----
 * 转换器代拉订阅时，机场看到的是「转换器发出的 UA」，而不是「你实际客户端的 UA」。
 * 若两者不一致（例如你用 Clash Verge，转换器却发 ClashForAndroid），
 * 部分机场会判定为「非本人操作 / 订阅地址可能已泄漏」，进而作废订阅地址。
 *
 * 因此 UA 可配置：
 *   auto   —— 透传调用方的 UA（推荐）。Clash Verge / OpenClash 请求 /sub 时
 *             自带自身 UA，直接转发即可，转换器对外完全透明。
 *             若调用方是浏览器（Mozilla/...），则回退到默认预设，
 *             避免机场看到一个「浏览器」在拉订阅。
 *   <预设> —— 固定使用某个客户端的 UA。
 *   custom —— 手动填写（抓包得到的真实 UA 最准确）。
 *
 * 注意：预设中的版本号只是常见取值。机场通常只做粗粒度匹配
 * （如包含 "clash-verge" / "OpenClash" / "ClashForAndroid"），
 * 若你的机场校验更严格，请用「自定义」填写真实 UA。
 */

/** 默认预设（调用方 UA 不可用时的兜底） */
const DEFAULT_UA_ID = 'clash-verge';

/** 最终兜底 UA */
const FALLBACK_UA = 'clash-verge/v2.0.0';

const UA_PRESETS = [
  {
    id: 'auto',
    name: '跟随调用方（推荐）',
    platform: '自动',
    ua: '',
    note: '透传代理客户端的 UA；浏览器 / curl 等非客户端请求回退到 Clash Verge',
  },
  {
    id: 'clash-verge',
    name: 'Clash Verge / Rev',
    platform: 'Windows · macOS · Linux',
    ua: 'clash-verge/v2.4.7',
  },
  {
    id: 'openclash',
    name: 'OpenClash',
    platform: 'OpenWrt · iStoreOS',
    ua: 'OpenClash/v0.46.0',
  },
  {
    id: 'mihomo',
    name: 'mihomo / Clash.Meta',
    platform: '内核通用',
    ua: 'mihomo/1.18.0',
  },
  {
    id: 'clash-for-windows',
    name: 'Clash for Windows',
    platform: 'Windows',
    ua: 'ClashforWindows/0.20.39',
  },
  {
    id: 'clash-for-android',
    name: 'Clash for Android',
    platform: 'Android',
    ua: 'ClashForAndroid/2.5.12',
  },
  {
    id: 'clashx',
    name: 'ClashX / ClashX Pro',
    platform: 'macOS',
    ua: 'ClashX/1.118.0',
  },
  {
    id: 'stash',
    name: 'Stash',
    platform: 'iOS · macOS',
    ua: 'Stash/2.5.0',
  },
  {
    id: 'shadowrocket',
    name: 'Shadowrocket',
    platform: 'iOS',
    ua: 'Shadowrocket/2.2.20',
  },
  {
    id: 'quantumultx',
    name: 'Quantumult X',
    platform: 'iOS',
    ua: 'Quantumult%20X/1.0.30',
  },
  {
    id: 'surge',
    name: 'Surge',
    platform: 'iOS · macOS',
    ua: 'Surge/5.8.0',
  },
  {
    id: 'sing-box',
    name: 'sing-box',
    platform: '通用',
    ua: 'sing-box/1.8.0',
  },
  {
    id: 'v2rayn',
    name: 'v2rayN',
    platform: 'Windows',
    ua: 'v2rayN/6.0',
  },
  {
    id: 'clash',
    name: 'Clash（原版）',
    platform: '通用',
    ua: 'clash/1.18.0',
  },
  {
    id: 'custom',
    name: '自定义',
    platform: '手动填写',
    ua: '',
    note: '填入抓包得到的真实 UA 最准确',
  },
];

const PRESET_MAP = new Map(UA_PRESETS.map(p => [p.id, p]));

/** 按 id 取预设 */
function getPreset(id) {
  return PRESET_MAP.get(id) || null;
}

/** 取某个预设的 UA 字符串（auto / custom 返回空） */
function presetUa(id) {
  const p = getPreset(id);
  return p && p.ua ? p.ua : '';
}

/** 是否是浏览器 UA */
function isBrowserUA(ua) {
  return /^Mozilla\//i.test(String(ua || '').trim());
}

/**
 * 已知代理客户端的 UA 特征。
 *
 * auto 模式只透传匹配这些特征的调用方 UA —— 否则会把 `node`、`curl/8.x`、
 * `python-requests` 这类通用 UA 转发给机场，在机场看来更像“订阅地址泄漏”。
 */
const PROXY_UA_PATTERN = new RegExp([
  'clash', 'mihomo', 'verge', 'stash', 'shadowrocket', 'quantumult', 'surge',
  'sing-box', 'singbox', 'v2ray', 'v2fly', 'xray', 'nekobox', 'nekoray',
  'hiddify', 'loon', 'karing', 'flclash', 'matsuri', 'passwall', 'openwrt',
  'sub-store', 'substore', 'shadowsocks', 'trojanc', 'naive',
].join('|'), 'i');

/** 调用方 UA 是否来自已知代理客户端 */
function isProxyClientUA(ua) {
  const s = String(ua || '').trim();
  if (!s || isBrowserUA(s)) return false;
  return PROXY_UA_PATTERN.test(s);
}

/** 列出预设（供前端使用） */
function listPresets() {
  return UA_PRESETS.map(p => ({ id: p.id, name: p.name, platform: p.platform, ua: p.ua, note: p.note || '' }));
}

/**
 * 解析出本次拉取实际要发送的 UA，并说明它是怎么来的。
 *
 * `source` 只用于日志：机场因 UA 不一致而作废订阅地址时，
 * 必须能一眼看出当时发的是哪个 UA、是配置选的还是透传的。
 *
 * @param {Object} fetchCfg  - 配置中的 fetch 段 { userAgent, customUserAgent }
 * @param {string} callerUA  - 调用方请求头里的 UA
 * @returns {{ua:string, source:string}}
 */
function resolveUserAgent(fetchCfg, callerUA) {
  const cfg = fetchCfg && typeof fetchCfg === 'object' ? fetchCfg : {};
  const mode = cfg.userAgent || DEFAULT_UA_ID;

  if (mode === 'custom') {
    const custom = String(cfg.customUserAgent || '').trim();
    if (custom) return { ua: custom, source: 'config:custom（配置页面手填）' };
    return {
      ua: presetUa(DEFAULT_UA_ID) || FALLBACK_UA,
      source: `config:custom 但未填写，已回退 ${DEFAULT_UA_ID}`,
    };
  }

  if (mode === 'auto') {
    const caller = String(callerUA || '').trim();
    // 仅当调用方确实是代理客户端时才透传；浏览器 / curl / node / python 等
    // 非客户端请求一律回退到默认预设，避免把“非客户端” UA 转给机场。
    if (isProxyClientUA(caller)) return { ua: caller, source: 'config:auto（透传调用方）' };
    return {
      ua: presetUa(DEFAULT_UA_ID) || FALLBACK_UA,
      source: `config:auto（调用方「${caller || '空'}」不是代理客户端，回退 ${DEFAULT_UA_ID}）`,
    };
  }

  const ua = presetUa(mode);
  if (ua) return { ua, source: `config:${mode}（预设）` };
  return {
    ua: presetUa(DEFAULT_UA_ID) || FALLBACK_UA,
    source: `config:${mode} 不是有效预设，已回退 ${DEFAULT_UA_ID}`,
  };
}

module.exports = {
  UA_PRESETS,
  DEFAULT_UA_ID,
  FALLBACK_UA,
  PROXY_UA_PATTERN,
  getPreset,
  presetUa,
  isBrowserUA,
  isProxyClientUA,
  listPresets,
  resolveUserAgent,
};
