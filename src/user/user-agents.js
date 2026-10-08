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

/**
 * 已知代理客户端的 UA 特征（来自 config/agent.json 的 proxyUaPatterns）。
 *
 * auto 模式只透传匹配这些特征的调用方 UA —— 否则会把 `node`、`curl/8.x`、
 * `python-requests` 这类通用 UA 转发给机场，在机场看来更像“订阅地址泄漏”。
 */
const PROXY_UA_PATTERN = CONFIG.proxyUaPatterns.length
	? new RegExp(CONFIG.proxyUaPatterns.join('|'), 'i')
	: null;

/** 调用方 UA 是否来自已知代理客户端 */
function isProxyClientUA(ua) {
	const s = String(ua || '').trim();
	if (!s || isBrowserUA(s)) return false;
	return PROXY_UA_PATTERN ? PROXY_UA_PATTERN.test(s) : false;
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
