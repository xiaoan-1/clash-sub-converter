/**
 * 用户配置读写
 *
 * 两层结构
 * --------
 *   config/default.json   基准 —— 含全部内置分组定义，**由部署人员直接编辑文件维护**
 *                         （纳入版本控制）
 *   guests/<访客ID>.json  访客配置，仅存与基准的差异
 *                         （由 src/user/guests.js 按访问者 IP 选择，被 .gitignore 忽略）
 *
 * 生效顺序：default.json ← guests/<ID>.json，后者覆盖前者。
 *
 * 注意**没有「站点基准 / 管理员」这一层**：基准是部署决策，直接改
 * config/default.json 即可，不通过 Web 界面修改。所有访问者（含本机）
 * 一视同仁，各自写自己的 guests/<IP>.json。
 *
 * readConfig(guestId) 返回合并后的完整配置，供 server/*.js / converter.js 共用：
 *   guestId 传访客 ID → default.json + guests/<ID>.json
 *   guestId 省略     → 仅 default.json（基准本身）
 *
 * 访客层只存差异，所以「没写过的项」永远跟随基准：部署人员改 default.json，
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

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'default.json');

/**
 * 规则分组未在 default.json 里时的兜底默认出口。
 * 必须与 proxy-groups.js 的 `ruleCfg?.defaultProxy || '♻️ 自动选择'` 一致，
 * 否则前端下拉框显示的默认出口与后端实际生成的分组不符。
 */
const DEFAULT_RULE_PROXY = '♻️ 自动选择';

/**
 * default.json 的进程内缓存。
 *
 * 每次 readConfig 都要用它，而一次 /sub 请求至少调用两次 readConfig
 * （sub.js 取 fetch 配置 + converter.js 取分组/过滤），实测每次同步读盘
 * 约 1.4ms —— 订阅客户端会定时刷新，多个客户端叠加就会阻塞事件循环。
 *
 * 用 mtimeMs + size 作为失效依据，而不是「启动时读一次」：
 * 部署人员改完 default.json 应当立刻生效，不该被迫重启服务
 * （README 明确写了「改完重启服务生效」，但能做到免重启更好）。
 * statSync 比 readFileSync + JSON.parse 快一个量级，且不会因配置变大而变慢。
 */
let defaultConfigCache = null; // { mtimeMs, size, data }

function loadDefaultConfig() {
	let stat;
	try {
		stat = fs.statSync(DEFAULT_CONFIG_PATH);
	} catch (err) {
		// 文件不存在/无权限：回退空配置，并清掉可能过期的缓存
		defaultConfigCache = null;
		log.fail('基准配置 config/default.json 读取失败，已回退为空配置', err, {
			path: DEFAULT_CONFIG_PATH,
		});
		return { groups: [], nodeFilters: {}, excludeKeywords: [], fetch: {} };
	}

	if (
		defaultConfigCache &&
		defaultConfigCache.mtimeMs === stat.mtimeMs &&
		defaultConfigCache.size === stat.size
	) {
		return defaultConfigCache.data;
	}

	try {
		const data = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
		defaultConfigCache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
		log.debug('基准配置已重新加载', {
			path: DEFAULT_CONFIG_PATH,
			groups: (data.groups || []).length,
		});
		return data;
	} catch (err) {
		log.fail('基准配置 config/default.json 解析失败，已回退为空配置', err, {
			path: DEFAULT_CONFIG_PATH,
		});
		return { groups: [], nodeFilters: {}, excludeKeywords: [], fetch: {} };
	}
}

/**
 * 补全 default.json 里缺失的规则分组。
 *
 * 分组有两个各自硬编码的来源：
 *   config/rules/*.json —— proxy-groups 由它推导，决定 Clash 输出里有哪些分组
 *   config/default.json —— 前端分组列表由它推导，决定用户能配置哪些分组
 * 新增一个规则文件不会自动出现在 default.json 里。以规则目录为准补全缺失项，
 * 避免「Clash 输出多出分组、配置界面却看不到」。
 *
 * 默认值与 proxy-groups.js 的分支保持一致：
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
 * 基准配置（default.json 本身，附带补全后的分组清单）。
 *
 * 这是唯一的基准来源 —— 没有「站点基准 / 管理员」中间层，
 * 部署人员直接编辑 config/default.json 即为全局生效的配置。
 * 访客层与 saveConfig 的差异计算都以它为参照物。
 */
function baseline() {
	const def = loadDefaultConfig();
	return {
		nodeFilters: def.nodeFilters || {},
		excludeKeywords: def.excludeKeywords || [],
		fetch: def.fetch || {},
		groups: effectiveGroups(def),
	};
}

/** 按 key 逐字段合并两份 groupOverrides，访客层覆盖基准层 */
function mergeGroupOverrides(base = {}, over = {}) {
	const out = {};
	for (const key of Object.keys(base)) out[key] = { ...base[key] };
	for (const key of Object.keys(over)) out[key] = { ...(out[key] || {}), ...over[key] };
	return out;
}

/**
 * 读取合并后的完整配置
 * @param {string|null} [guestId] 访客 ID；省略 / null 时只返回基准（default.json）
 */
function readConfig(guestId) {
	// default.json 只读一次：baseline() 与下面的 effectiveGroups() 都要用，
	// 而 loadDefaultConfig() 没有缓存，读两遍等于每个请求多解析一次 JSON。
	const def = loadDefaultConfig();
	// 访客文件不存在时 readGuestConfig 直接返回 {} —— 读路径不落盘，
	// 即「打开配置页只看不改」不会创建 guests/<ID>.json。
	const guest = guestId ? guests.readGuestConfig(guestId) : null;

	const base = {
		nodeFilters: def.nodeFilters || {},
		excludeKeywords: def.excludeKeywords || [],
		fetch: def.fetch || {},
		groupOverrides: {},
	};

	const effective = guest
		? {
				nodeFilters: { ...base.nodeFilters, ...(guest.nodeFilters || {}) },
				excludeKeywords:
					guest.excludeKeywords !== undefined
						? guest.excludeKeywords
						: base.excludeKeywords,
				fetch: { ...base.fetch, ...(guest.fetch || {}) },
				groupOverrides: mergeGroupOverrides(base.groupOverrides, guest.groupOverrides),
			}
		: base;

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
		scope: guestId || '基准（default.json）',
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
 * 逐字段存差异而不是整对象覆盖，这样访客没碰过的那个开关仍会跟随基准。
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
 * 保存访客配置 —— 仅存与基准（default.json）的差异
 *
 * 写入 guests/<访客ID>.json。基准是 config/default.json —— 部署人员直接编辑
 * 它来改全局配置，Web 界面不提供修改基准的途径。
 *
 * @param {Object} newConfig 界面回传的完整配置
 * @param {string} guestId   访客 ID（必填；所有访问者含本机都是访客）
 * @returns {Object} 实际写入的配置
 */
function saveConfig(newConfig, guestId) {
	if (!guestId) {
		throw new Error('缺少访客 ID：基准配置请直接编辑 config/default.json');
	}
	const base = baseline();

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

	// 只写有差异的字段：文件里没出现的项 = 完全继承基准，将来会跟着基准一起变
	const out = {};
	if (Object.keys(nodeFilters).length > 0) out.nodeFilters = nodeFilters;
	if (excludeKeywords !== undefined) out.excludeKeywords = excludeKeywords;
	if (Object.keys(groupOverrides).length > 0) out.groupOverrides = groupOverrides;
	if (Object.keys(fetchOv).length > 0) out.fetch = fetchOv;

	const target = guests.writeGuestConfig(guestId, out);

	log.info('访客配置已保存', {
		path: target,
		guest: guestId,
		// 空对象是正常结果：代表该访客当前完全跟随基准
		diffKeys: Object.keys(out),
		nodeFilters: out.nodeFilters,
		excludeKeywords: out.excludeKeywords ? out.excludeKeywords.length : '(继承)',
		fetch: out.fetch ? JSON.stringify(out.fetch) : '(继承)',
		groupOverrides: out.groupOverrides ? Object.keys(out.groupOverrides).length : 0,
	});

	return out;
}

module.exports = {
	DEFAULT_CONFIG_PATH,
	loadDefaultConfig,
	baseline,
	readConfig,
	saveConfig,
};
