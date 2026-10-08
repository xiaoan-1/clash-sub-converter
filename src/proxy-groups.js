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

/** 分组共用的固定候选出口（Clash 以 proxies 首项为默认出口，故默认出口排头） */
const FIXED_OPTIONS = ['🚀 节点选择', '♻️ 自动选择', 'DIRECT'];
/** url-test 分组的测速地址 */
const TEST_URL = 'http://www.gstatic.com/generate_204';
/** 名称里没有可识别地区关键词的节点归入此组，否则它们不会被任何分组引用 */
const OTHER_LABEL = '🌐 其他地区';

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
	return upper => {
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
 * 分组采用两级结构：上层 select 分组（节点选择 / 规则分组 / 漏网之鱼）的候选是
 * **地区分组**而非上百个具体节点，用户在客户端先选地区、再在地区组里选节点。
 * 地区分组未生成时（生成器关闭或无任何可识别地区）回退为直接列具体节点，
 * 否则会出现「候选为空」或「国际节点无处可选」。
 *
 * @param {Array} proxies - 已过滤的代理节点数组
 * @param {Object} options
 * @param {Array} options.userGroups - 用户分组配置（来自 config/default.json）
 * @returns {Array} 分组数组，另带 `regionNames` 属性（本次生成的地区分组名）
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
	const builtinMap = new Map(); // builtin -> config
	const ruleMap = new Map(); // ruleId -> config
	for (const ug of userGroups) {
		if (ug.builtin) builtinMap.set(ug.builtin, ug);
		else if (ug.ruleId) ruleMap.set(ug.ruleId, ug);
	}

	// ===== 地区归类（地区分组与上层分组的候选项共用）=====
	// 上层 select 分组（节点选择 / 规则分组 / 漏网之鱼）的候选默认是**地区分组**
	// 而非上百个具体节点：这是 Clash 的两级结构 —— 上层选地区，地区组内再选节点。
	const regionMap = new Map(); // 地区标签 -> 节点名列表
	const unclassified = []; // 名称里没有可识别地区关键词的节点
	for (const name of activeProxies) {
		const region = getRegion(name);
		if (!region) {
			unclassified.push(name);
			continue;
		}
		// 国内节点由「🇨🇳 中国大陆」统一承载，不再单独建组
		if (region === CN_LABEL) continue;
		if (!regionMap.has(region)) regionMap.set(region, []);
		regionMap.get(region).push(name);
	}

	const regionsCfg = builtinMap.get('regions');
	const regionsEnabled = !regionsCfg || regionsCfg.enabled !== false;
	const regionType = regionsCfg?.type || 'url-test';

	const domesticCfg = builtinMap.get('domestic');
	const domesticEnabled =
		domesticProxies.size > 0 && (!domesticCfg || domesticCfg.enabled !== false);

	// 无法识别地区的节点若不属于任何组，就彻底无法被选中（没有分组引用它们）
	if (regionsEnabled && unclassified.length) {
		regionMap.set(OTHER_LABEL, unclassified);
	}

	// 地区分组清单：中国大陆排前，其余按出现顺序。供前端「默认出口」下拉使用
	const regionNames = [];
	if (domesticEnabled) regionNames.push(CN_LABEL);
	if (regionsEnabled) regionNames.push(...regionMap.keys());

	// 只有「地区分组确实生成了」才用地区分组当候选：生成器关闭时 regionNames
	// 可能只剩「中国大陆」，用它当候选会让国际节点无处可选。
	const useRegionCandidates = regionsEnabled && regionMap.size > 0;
	const candidates = useRegionCandidates ? regionNames : activeProxies;

	const groups = [];

	// 1. 🚀 节点选择（必须，不可禁用）
	groups.push({
		name: '🚀 节点选择',
		type: 'select',
		proxies: ['♻️ 自动选择', 'DIRECT', ...candidates],
	});

	// 2. ♻️ 自动选择（必须，不可禁用）
	//    只对非国内节点测速：国内节点走直连更合适，参与测速会让自动选择偏向国内。
	//    该分组被「🚀 节点选择」和所有规则分组引用，因此无论如何都要创建 ——
	//    一旦缺失，mihomo 会因 proxy not found 拒绝加载整份配置。
	const autoProxies = activeProxies.filter(n => !domesticProxies.has(n));
	// 无非国内节点（如订阅里全是国内节点）时退化为全部活跃节点；再没有就只能直连
	const autoTargets = autoProxies.length
		? autoProxies
		: activeProxies.length
			? activeProxies
			: ['DIRECT'];
	groups.push({
		name: '♻️ 自动选择',
		type: 'url-test',
		url: TEST_URL,
		interval: 300,
		tolerance: 50,
		proxies: autoTargets,
	});

	// 3. 🇨🇳 中国大陆（可选，仅在有国内节点时出现）
	if (domesticEnabled) {
		// 类型与默认出口跟随界面配置：原实现写死 select + DIRECT，
		// 界面上的两个下拉框选了也不生效。
		const defProxy = domesticCfg?.defaultProxy || 'DIRECT';
		const otherOptions = FIXED_OPTIONS.filter(o => o !== defProxy);
		groups.push({
			name: CN_LABEL,
			type: domesticCfg?.type || 'select',
			proxies: [defProxy, ...otherOptions, ...domesticProxies],
		});
	}

	// 4. 地区分组（可选，默认开）：按地区标签归类，只对出现过的地区建组。
	//    界面上的「🌏 地区分组」是生成器而非分组本身，其 type 决定生成出来的
	//    每个地区组是手动选择还是自动测速；地区组只装本地区节点，故没有默认出口。
	//    先收集、最后追加：客户端按数组顺序展示分组，地区组数量多且很少改动，
	//    排在常用分组（节点选择 / 规则组 / 漏网之鱼）之后更便于查找。
	const regionGroups = [];
	if (regionsEnabled) {
		for (const [label, names] of regionMap) {
			const group = { name: label, type: regionType, proxies: names };
			// 测速参数只对 url-test 有意义，select 组带上会被内核忽略但也算脏数据
			if (regionType === 'url-test') {
				group.url = TEST_URL;
				group.interval = 300;
				group.tolerance = 50;
			}
			regionGroups.push(group);
		}
		if (regionMap.size) {
			log.debug('地区分组生成', {
				regions: regionMap.size,
				type: regionType,
				list: [...regionMap.keys()],
			});
		}
	}

	// 5. 规则分组（可选，默认开）
	//    每个规则分组 = defaultProxy 排头 + 其余两个固定选项(节点选择/自动选择/DIRECT 三选二) + 所有活跃节点
	for (const rc of ruleManager.getAll()) {
		if (rc.id === ALWAYS_ON_RULE_ID) continue;

		const ruleCfg = ruleMap.get(rc.id);
		if (ruleCfg && ruleCfg.enabled === false) {
			log.debug('规则分组被用户关闭，跳过', { id: rc.id, name: rc.name });
			continue;
		}

		const defProxy = ruleCfg?.defaultProxy || '♻️ 自动选择';
		const otherOptions = FIXED_OPTIONS.filter(o => o !== defProxy);

		groups.push({
			name: ruleCfg?.name || rc.name,
			type: ruleCfg?.type || rc.type || 'select',
			proxies: [defProxy, ...otherOptions, ...candidates],
			defaultProxy: defProxy,
		});
	}

	// 6. 🐟 漏网之鱼（必须，不可禁用）
	//    首项仍为「🚀 节点选择」（沿用跟随全局选择的传统默认行为），
	//    但额外补上「♻️ 自动选择」：否则用户想让它直接全局自动时只能绕经
	//    「节点选择」，多一跳且受该组当前状态影响。
	groups.push({
		name: '🐟 漏网之鱼',
		type: 'select',
		proxies: ['🚀 节点选择', '♻️ 自动选择', 'DIRECT', ...candidates],
	});

	// 7. 地区分组统一追加在最后（见第 4 步说明）
	groups.push(...regionGroups);

	log.info('分组生成完成', {
		groups: groups.length,
		list: groups.map(g => `${g.name}(${g.type},${g.proxies.length})`),
	});

	const result = sanitizeGroupRefs(groups, activeProxies);
	// 地区分组清单挂在数组上供 converter 生成 summary（前端「默认出口」下拉要用）。
	// 数组自带属性不会被 yaml.dump 序列化，不影响输出。
	result.regionNames = regionNames;
	return result;
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
	const valid = new Set([...groups.map(g => g.name), ...BUILTIN_PROXIES, ...proxyNames]);

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
	CN_LABEL,
};
