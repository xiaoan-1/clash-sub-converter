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
 * 预设列表与判定规则定义在 `config/agent.json`（配置驱动）：
 *   defaultId        默认预设 id（调用方 UA 不可用时用它）
 *   fallbackUa       最终兜底 UA（预设缺失时的最后一道防线）
 *   proxyUaPatterns  代理客户端 UA 特征（auto 模式据此判断是否透传调用方 UA）
 *   presets          可选预设列表
 * 增删预设改配置即可，无需改代码。
 *
 * 注意：预设中的版本号只是常见取值。机场通常只做粗粒度匹配
 * （如包含 "clash-verge" / "OpenClash" / "ClashForAndroid"），
 * 若你的机场校验更严格，请用「自定义」填写真实 UA。
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const log = logger.create('user-agents');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'agent.json');

/** 内置兜底，配置文件缺失/损坏时使用 */
const BUILTIN = {
	defaultId: 'clash-verge',
	fallbackUa: 'clash-verge/v2.0.0',
	proxyUaPatterns: [],
	proxyUaExcludes: [],
	presets: [],
};

/** 读取并校验配置，异常时回退内置值 */
function loadConfig() {
	try {
		const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
		return {
			defaultId: raw.defaultId || BUILTIN.defaultId,
			fallbackUa: raw.fallbackUa || BUILTIN.fallbackUa,
			proxyUaPatterns: Array.isArray(raw.proxyUaPatterns) ? raw.proxyUaPatterns : [],
			proxyUaExcludes: Array.isArray(raw.proxyUaExcludes) ? raw.proxyUaExcludes : [],
			presets: Array.isArray(raw.presets) ? raw.presets.filter(p => p && p.id) : [],
		};
	} catch (err) {
		log.warn('UA 预设配置读取失败，已回退内置默认值', {
			path: CONFIG_PATH,
			reason: err.message,
		});
		return { ...BUILTIN };
	}
}

const CONFIG = loadConfig();

const UA_PRESETS = CONFIG.presets;
const DEFAULT_UA_ID = CONFIG.defaultId;
const FALLBACK_UA = CONFIG.fallbackUa;

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

/** 转义正则元字符，避免配置里的 `[` `(` 等让 new RegExp 抛错 */
function escapeRegExp(s) {
	return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造「代理客户端特征」正则（子串匹配，忽略大小写）。
 *
 * 关键难点：真实客户端名里既有「前缀粘连」（OpenClash、ClashX、v2rayN），
 * 也有「后缀粘连」（ClashForAndroid、ClashforWindows），因此**不能用统一的
 * 词边界** —— 加了边界会漏判 ClashX / OpenClash / v2rayN。
 * 所以这里保留子串匹配（保证不漏判），误判交由下面的黑名单处理。
 *
 * 同时转义正则元字符并兜住构造异常：agent.json 是用户可编辑文件，
 * 一个手滑（如填 `naive+`）不能让整个模块在 require 阶段崩溃。
 *
 * @returns {RegExp|null}
 */
function buildUaPattern(words) {
	const list = (Array.isArray(words) ? words : []).map(p => String(p).trim()).filter(Boolean);
	if (!list.length) return null;
	try {
		return new RegExp(`(${list.map(escapeRegExp).join('|')})`, 'i');
	} catch (err) {
		log.warn('UA 特征正则构造失败', { words: list, reason: err.message });
		return null;
	}
}

/**
 * 已知代理客户端的 UA 特征（来自 config/agent.json 的 proxyUaPatterns）。
 *
 * auto 模式只透传匹配这些特征的调用方 UA —— 否则会把 `node`、`curl/8.x`、
 * `python-requests` 这类通用 UA 转发给机场，在机场看来更像“订阅地址泄漏”。
 */
const PROXY_UA_PATTERN = buildUaPattern(CONFIG.proxyUaPatterns);

/**
 * 非代理词黑名单（来自 config/agent.json 的 proxyUaExcludes）。
 *
 * 子串匹配会把 `prestashop`（含 stash）、`myxrayclient`（含 xray）这类
 * 非代理 UA 误判成客户端，导致它们被原样透传给机场 —— 与「非客户端要回退」
 * 的设计相反。命中黑名单即判定为非代理客户端。
 *
 * 黑名单用**词边界**匹配，避免误伤 `prestashop-clash` 这种真实含客户端名的串。
 */
const PROXY_UA_EXCLUDE_PATTERN = (() => {
	const list = (Array.isArray(CONFIG.proxyUaExcludes) ? CONFIG.proxyUaExcludes : [])
		.map(p => String(p).trim())
		.filter(Boolean);
	if (!list.length) return null;
	try {
		return new RegExp(`\\b(${list.map(escapeRegExp).join('|')})\\b`, 'i');
	} catch (err) {
		log.warn('UA 黑名单正则构造失败，已忽略', { excludes: list, reason: err.message });
		return null;
	}
})();

/** 调用方 UA 是否来自已知代理客户端 */
function isProxyClientUA(ua) {
	const s = String(ua || '').trim();
	if (!s || isBrowserUA(s)) return false;
	if (!PROXY_UA_PATTERN || !PROXY_UA_PATTERN.test(s)) return false;
	// 命中黑名单 → 不算代理客户端
	if (PROXY_UA_EXCLUDE_PATTERN && PROXY_UA_EXCLUDE_PATTERN.test(s)) return false;
	return true;
}

/** 列出预设（供前端使用） */
function listPresets() {
	return UA_PRESETS.map(p => ({
		id: p.id,
		name: p.name,
		platform: p.platform,
		ua: p.ua,
		note: p.note || '',
	}));
}

/** UA 长度上限：正常客户端 UA 远短于此，超长多半是异常输入 */
const MAX_UA_LEN = 200;

/**
 * 清洗最终要发送的 UA。
 *
 * 调用方 UA（`?ua=` 或请求头）是外部可控输入：
 *   - 控制字符（\r \n \t）会让日志被伪造、对端解析异常；
 *   - **非 ASCII 字符**（如中文）无法编码为 HTTP 头 —— fetch 会直接抛
 *     `Cannot convert argument to a ByteString`，导致订阅拉取失败。
 * 真实客户端 UA 都是可打印 ASCII，因此这里只保留 `\x20-\x7e`，其余换成空格，
 * 并限制长度。保证送出去的一定是单行可打印 ASCII 字符串。
 *
 * @returns {string} 清洗后的 UA，全被剥掉时返回空串
 */
function sanitizeUa(raw) {
	return (
		String(raw == null ? '' : raw)
			// 非可打印 ASCII（含控制字符、中文等）一律换成空格，避免粘连
			.replace(/[^\x20-\x7e]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, MAX_UA_LEN)
	);
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
	// 预设 id 与模式名统一小写比较：用户手改 config.json 时大小写不一致
	// （如 AUTO / Custom）不应静默降级，否则会丢掉 auto 的透传能力。
	const mode = String(cfg.userAgent || DEFAULT_UA_ID)
		.trim()
		.toLowerCase();

	if (mode === 'custom') {
		const custom = sanitizeUa(cfg.customUserAgent);
		if (custom) return { ua: custom, source: 'config:custom（配置页面手填）' };
		return {
			ua: presetUa(DEFAULT_UA_ID) || FALLBACK_UA,
			source: `config:custom 但未填写，已回退 ${DEFAULT_UA_ID}`,
		};
	}

	if (mode === 'auto') {
		const caller = sanitizeUa(callerUA);
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
	PROXY_UA_EXCLUDE_PATTERN,
	getPreset,
	presetUa,
	isBrowserUA,
	isProxyClientUA,
	sanitizeUa,
	listPresets,
	resolveUserAgent,
};
