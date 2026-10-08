/**
 * 用户配置读写
 *
 * 三层结构
 * --------
 *   config/default.json   基准，含全部内置分组定义（纳入版本控制）
 *   config.json           站点基准 —— 管理员自己的配置，也是所有访客的起点
 *                         （位于项目根目录，被 .gitignore 忽略）
 *   guests/<访客ID>.json  访客配置，仅存与「站点基准」的差异
 *                         （由 src/guests.js 按访问者 IP 选择，被 .gitignore 忽略）
 *
 * 生效顺序：default.json ← config.json ← guests/<ID>.json，后者覆盖前者。
 *
 * readConfig(guestId) 返回合并后的完整配置，供 index.js / api.js / converter.js 共用：
 *   guestId 传 null（管理员）→ default.json + config.json
 *   guestId 传访客 ID       → 上面再叠加 guests/<ID>.json
 *
 * 每一层都只存差异，所以「上层没写过的项」永远跟随下层：管理员改站点基准，
 * 没动过该项的访客会自动跟着变。
 *
 * 注意：订阅链接不在其中。它是每次请求的输入（`/sub?url=` 或页面上临时填写的地址），
 * 用完即弃，不属于需要持久化的用户配置 —— 也正因为如此，同一份 guests/<IP>.json
 * 可以让该访客用任意多个不同的订阅链接，互不干扰。
 */

const fs = require('fs');
const path = require('path');
const { ruleManager } = require('../rule-manager');
const { ruleGroupKeys } = require('../rule-groups');
const guests = require('./guests');
const logger = require('../logger');

const log = logger.create('config');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'default.json');

/**
 * 规则分组未在 default.json 里时的兜底默认出口。
 * 必须与 proxy-groups.js 的 `ruleCfg?.defaultProxy || '♻️ 自动选择'` 一致，
 * 否则前端下拉框显示的默认出口与后端实际生成的分组不符。
 */
const DEFAULT_RULE_PROXY = '♻️ 自动选择';

/**
 * 加载 default.json 作为基准
 */
function loadDefaultConfig() {
	try {
		return JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
	} catch (err) {
		log.fail('基准配置 config/default.json 读取失败，已回退为空配置', err, {
			path: DEFAULT_CONFIG_PATH,
		});
		return { groups: [], nodeFilters: {}, excludeKeywords: [], fetch: {} };
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
		log.debug('用户配置 config.json 不存在，使用全部默认值', { path: CONFIG_PATH });
	} catch (err) {
		log.fail('用户配置 config.json 解析失败，已回退为默认值', err, { path: CONFIG_PATH });
	}
	return {};
}

/**
 * 补全 default.json 里缺失的规则分组。
 *
 * 分组有两个各自硬编码的来源：
 *   config/rules/*.json —— proxy-groups 由它推导，决定 Clash 输出里有哪些分组
 *   config/default.json —— 前端分组列表由它推导，决定用户能配置哪些分组
 * 新增一个规则文件不会自动出现在 default.json 里。于是经 POST /api/rules
 * 新增规则后，Clash 输出多出了该分组，配置界面却看不到它：用户无法禁用、
 * 无法改默认出口、无法改类型，保存时还会被 saveConfig 静默跳过
 * （user-config.js: `const dg = defGroupMap[key]; if (!dg) return;`）。
 *
 * 以规则目录为准补全缺失项，默认值与 proxy-groups.js 的分支保持一致：
 *   name      = ruleCfg?.name || rc.name
 *   type      = ruleCfg?.type || rc.type || 'select'
 *   defaultProxy = ruleCfg?.defaultProxy || '♻️ 自动选择'
 *
 * @param {Array} baseGroups default.json 里的 groups
 * @returns {Array} 需要补充分组
 */
function missingRuleGroups(baseGroups) {
	const known = new Set();
	for (const g of baseGroups) {
		const key = g.ruleId || g.builtin;
		if (key) known.add(key);
	}

	const extra = [];
	for (const id of ruleGroupKeys()) {
		if (known.has(id)) continue;
		const rc = ruleManager.getById(id);
		if (!rc) continue;
		extra.push({
			ruleId: id,
			name: rc.name,
			type: rc.type || 'select',
			enabled: true,
			defaultProxy: DEFAULT_RULE_PROXY,
		});
	}
	return extra;
}

/**
 * 生效的分组基准 = default.json 的 groups + 规则目录补全。
 * readConfig 与 saveConfig 必须用同一份基准，否则补充分组的修改存不下来。
 */
function effectiveGroups(def) {
	const base = def.groups || [];
	return [...base, ...missingRuleGroups(base)];
}

/**
 * 站点基准 —— default.json ← config.json 合并后的结果。
 * 等价于「没有访客时 readConfig() 的返回值」，是访客层计算差异的参照物。
 * @param {Object} [def] 已加载的 default.json（避免同一次请求里重复读盘）
 */
function siteConfig(def = loadDefaultConfig()) {
	const user = loadUserConfig();

	return {
		nodeFilters: { ...(def.nodeFilters || {}), ...(user.nodeFilters || {}) },
		excludeKeywords:
			user.excludeKeywords !== undefined ? user.excludeKeywords : def.excludeKeywords || [],
		fetch: { ...(def.fetch || {}), ...(user.fetch || {}) },
		groupOverrides: user.groupOverrides || {},
	};
}

/**
 * default.json 本身作为基准（附带补全后的分组清单）。
 * 供管理员配置 config.json 计算差异用 —— 它的下层只有 default.json。
 */
function defaultBaseline() {
	const def = loadDefaultConfig();
	return {
		nodeFilters: def.nodeFilters || {},
		excludeKeywords: def.excludeKeywords || [],
		fetch: def.fetch || {},
		groups: effectiveGroups(def),
	};
}

/** 按 key 逐字段合并两份 groupOverrides，访客层覆盖站点层 */
function mergeGroupOverrides(base = {}, over = {}) {
	const out = {};
	for (const key of Object.keys(base)) out[key] = { ...base[key] };
	for (const key of Object.keys(over)) out[key] = { ...(out[key] || {}), ...over[key] };
	return out;
}

/**
 * 读取合并后的完整配置
 * @param {string|null} [guestId] 访客 ID；null / 省略表示管理员（不叠加访客层）
 */
function readConfig(guestId) {
	// default.json 只读一次：siteConfig() 与下面的 effectiveGroups() 都要用，
	// 而 loadDefaultConfig() 没有缓存，读两遍等于每个请求多解析一次 JSON。
	const def = loadDefaultConfig();
	const site = siteConfig(def);
	// 访客文件不存在时 readGuestConfig 直接返回 {} —— 读路径不落盘，
	// 即「打开配置页只看不改」不会创建 guests/<ID>.json。
	const guest = guestId ? guests.readGuestConfig(guestId) : null;

	const effective = guest
		? {
				nodeFilters: { ...site.nodeFilters, ...(guest.nodeFilters || {}) },
				excludeKeywords:
					guest.excludeKeywords !== undefined
						? guest.excludeKeywords
						: site.excludeKeywords,
				fetch: { ...site.fetch, ...(guest.fetch || {}) },
				groupOverrides: mergeGroupOverrides(site.groupOverrides, guest.groupOverrides),
			}
		: site;

	// 基准固定用 default.json 的分组定义（不是已合并的结果）：
	// 若拿「已带覆盖的分组」当基准，用户把某项改回默认值时算不出差异，
	// 旧的覆盖会永远留在文件里，之后改 default.json 也再生效。
	const groups = effectiveGroups(def).map(dg => {
		const key = dg.ruleId || dg.builtin;
		const ov = effective.groupOverrides[key] || {};
		return {
			...dg,
			...ov,
			enabled: ov.enabled !== undefined ? ov.enabled : dg.enabled !== false,
		};
	});

	const result = {
		nodeFilters: effective.nodeFilters,
		excludeKeywords: effective.excludeKeywords,
		fetch: effective.fetch,
		groups,
	};

	// readConfig 每次请求都会被调用多次，只在 debug 级记录，便于核对「界面改了但没生效」
	log.debug('配置已加载', {
		scope: guestId || '站点基准（管理员）',
		guestOverrideKeys: guest ? Object.keys(guest) : undefined,
		groups: groups.length,
		disabled: groups.filter(g => g.enabled === false).map(g => g.ruleId || g.builtin),
		nodeFilters: result.nodeFilters,
		excludeKeywords: result.excludeKeywords.length,
		fetch: JSON.stringify(effective.fetch),
	});

	return result;
}

/** 两份 JSON 是否完全一致（用于判断数组型配置如 excludeKeywords 有无改动） */
function sameJson(a, b) {
	return (
		JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
	);
}

/**
 * 只保留与基准不同的节点过滤开关。
 * 逐字段存差异而不是整对象覆盖，这样访客没碰过的那个开关仍会跟随站点基准。
 */
function diffNodeFilters(base = {}, next = {}) {
	const out = {};
	for (const k of ['hideDomestic', 'hideInternational']) {
		if (next[k] !== undefined && next[k] !== !!base[k]) out[k] = next[k];
	}
	return out;
}

/**
 * 分组覆盖：逐字段与基准分组对比，只存不同项。
 * @param {Array} baseGroups 基准分组（访客场景传站点已生效的分组）
 * @param {Array} newGroups  界面回传的分组
 */
function diffGroups(baseGroups, newGroups) {
	const baseMap = {};
	for (const g of baseGroups) {
		const key = g.ruleId || g.builtin;
		if (key) baseMap[key] = g;
	}

	const out = {};
	for (const g of newGroups) {
		const key = g.ruleId || g.builtin;
		const bg = baseMap[key];
		// 分组不在基准里（如前端多回传的未知分组）→ 忽略
		if (!bg) continue;
		const ov = {};
		const baseEnabled = bg.enabled !== false;
		if (g.enabled !== undefined && g.enabled !== baseEnabled) ov.enabled = g.enabled;
		if (g.type !== undefined && g.type !== bg.type) ov.type = g.type;
		if (g.defaultProxy !== undefined && g.defaultProxy !== bg.defaultProxy)
			ov.defaultProxy = g.defaultProxy;
		if (Object.keys(ov).length > 0) out[key] = ov;
	}
	return out;
}

/**
 * 保存用户配置 —— 仅存与基准的差异
 *
 * 写入目标由 guestId 决定：
 *   不传（管理员）→ config.json，基准是 default.json
 *   传（访客）    → guests/<访客ID>.json，基准是「站点生效配置」
 *
 * 访客的基准必须是站点生效配置而不是 default.json：否则访客会把管理员配置
 * 原样复制一份存起来，之后管理员改站点基准，这些访客再也不会跟着变。
 *
 * @param {Object} newConfig 界面回传的完整配置
 * @param {string|null} [guestId]
 * @returns {Object} 实际写入的配置
 */
function saveConfig(newConfig, guestId) {
	// 基准 = 「本文件所在层的下一层」合并后的结果
	const base = guestId
		? readConfig(null) // 访客的下层 = 站点生效配置
		: defaultBaseline(); // 管理员的下层 = default.json

	// ---- 节点过滤 ----
	const nodeFilters = diffNodeFilters(base.nodeFilters, newConfig.nodeFilters || {});

	// ---- 排除关键词 ----
	const excludeKeywords = sameJson(newConfig.excludeKeywords, base.excludeKeywords)
		? undefined
		: newConfig.excludeKeywords || [];

	// ---- 分组覆盖 ----
	const groupOverrides = diffGroups(base.groups, newConfig.groups || []);

	// ---- 拉取设置覆盖 ----
	const newFetch = newConfig.fetch || {};
	const fetchOv = {};
	for (const k of ['userAgent', 'customUserAgent']) {
		if (newFetch[k] !== undefined && newFetch[k] !== base.fetch?.[k]) fetchOv[k] = newFetch[k];
		// 已不存在的键交给 default.json 兜底，避免把旧值一直带在文件里
	}

	// 只写有差异的字段：文件里没出现的项 = 完全继承下层，将来会跟着下层一起变
	const out = {};
	if (Object.keys(nodeFilters).length > 0) out.nodeFilters = nodeFilters;
	if (excludeKeywords !== undefined) out.excludeKeywords = excludeKeywords;
	if (Object.keys(groupOverrides).length > 0) out.groupOverrides = groupOverrides;
	if (Object.keys(fetchOv).length > 0) out.fetch = fetchOv;

	let target;
	if (guestId) {
		target = guests.writeGuestConfig(guestId, out);
	} else {
		target = CONFIG_PATH;
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf-8');
	}

	log.info(guestId ? '访客配置已保存' : '站点配置已保存', {
		path: target,
		guest: guestId || undefined,
		// 空对象是正常结果：代表该访客当前完全跟随站点基准
		diffKeys: Object.keys(out),
		nodeFilters: out.nodeFilters,
		excludeKeywords: out.excludeKeywords ? out.excludeKeywords.length : '(继承)',
		fetch: out.fetch ? JSON.stringify(out.fetch) : '(继承)',
		groupOverrides: out.groupOverrides ? Object.keys(out.groupOverrides).length : 0,
	});

	return out;
}

module.exports = {
	CONFIG_PATH,
	DEFAULT_CONFIG_PATH,
	loadDefaultConfig,
	loadUserConfig,
	siteConfig,
	readConfig,
	saveConfig,
};
