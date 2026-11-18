const yaml = require('js-yaml');
const {
	generateProxyGroups,
	isDomestic,
	normalizeExcludeKeywords,
	filterByExcludeKeywords,
	BUILTIN_GROUP_NAMES,
} = require('./proxy-groups');
const { ruleManager, ruleTargetOf } = require('./rule-manager');
const { readConfig } = require('./user/user-config');
const logger = require('./logger');

const log = logger.create('converter');

/**
 * 全部节点都被过滤规则排除时抛出。
 * 这是用户的过滤配置问题而非服务端故障，上层应据此返回 400 并给出可操作提示。
 */
class AllProxiesFilteredError extends Error {
	constructor(totalNodes, hint) {
		super(`全部 ${totalNodes} 个节点都被过滤条件排除，无法生成可用配置`);
		this.name = 'AllProxiesFilteredError';
		this.code = 'ALL_PROXIES_FILTERED';
		this.totalNodes = totalNodes;
		this.hint =
			hint || '请放宽「排除关键词」或「节点过滤」，或检查是否误填了会命中全部节点的关键词';
	}
}

/**
 * 解析本次转换要用的用户配置。
 * options 显式传入的优先（API 可以按请求覆盖），否则回退到配置文件。
 * Clash 与 Surge 共用，保证两个入口的过滤/分组策略一致。
 *
 * options.guestId 决定读哪一份配置：传访客 ID = default.json + 该访客的差异；
 * 省略 / null = 仅 default.json（基准本身）。
 * 必须由调用方从请求里解析后传进来 —— 转换器本身拿不到 req，
 * 若在这里自己猜，访客就会拿到别人的分组策略。
 */
function resolveUserConfig(options = {}) {
	const userConfig = readConfig(options.guestId);
	return {
		// 用 length 判断而不是 `||`：空数组是 truthy，会让 `userGroups: []`
		// 覆盖掉配置里的分组开关（表现为「配置页关掉的分组又冒出来」）。
		// 空数组应视为「未指定，走配置」。
		userGroups:
			Array.isArray(options.userGroups) && options.userGroups.length
				? options.userGroups
				: userConfig?.groups || [],
		// nodeFilters / excludeKeywords 用「是否传了」判断，不能用真值判断：
		// `{}`（两个开关都关）与 `[]`（清空关键词）都是调用方的明确意图，
		// 而 `||` 会把它们当成「未指定」而回退到配置，导致
		// 「请求里要求全部节点 / 不排除关键词」被配置里的默认值覆盖。
		nodeFilters:
			options.nodeFilters && typeof options.nodeFilters === 'object'
				? options.nodeFilters
				: userConfig?.nodeFilters || {},
		excludeKeywords: Array.isArray(options.excludeKeywords)
			? options.excludeKeywords
			: userConfig?.excludeKeywords || [],
	};
}

/**
 * 本次实际可能生成的分组名（内置分组 + 配置里的分组 + 规则文件默认名）。
 *
 * 节点与这些名字同名时会被内核解析成分组，节点永远选不中，
 * 因此提前收集起来交给 dedupeAndRenameReserved。
 */
function reservedGroupNames(userGroups) {
	const names = new Set(BUILTIN_GROUP_NAMES);
	for (const g of userGroups || []) {
		if (g && g.name) names.add(String(g.name));
	}
	for (const rc of ruleManager.getAll()) names.add(rc.name);
	return [...names];
}

/**
 * 按用户配置过滤节点：先按关键词排除，再按国内/国际开关过滤。
 *
 * 节点被过滤干净时立即抛错：否则会产出一份「没有真实节点」的空壳配置，
 * 客户端能加载但一个节点都用不了，用户只会看到节点凭空消失而无从排查。
 *
 * @param {Array} proxies
 * @param {Object} nodeFilters - { hideDomestic, hideInternational }
 * @param {Array} excludeKeywords
 * @param {string[]} reservedNames - 节点不能与之同名的分组名
 * @returns {Array} 过滤后的节点
 */
function applyNodeFilters(proxies, nodeFilters = {}, excludeKeywords = [], reservedNames = []) {
	const { hideDomestic = false, hideInternational = false } = nodeFilters;

	// 0. 关键词排除（空串会命中所有节点，由 filterByExcludeKeywords 内部剔除）
	const afterKeywords = filterByExcludeKeywords(proxies, excludeKeywords);
	let activeProxies = afterKeywords;

	// 0.5 国内/国际过滤（两个同时开启 = 无意义，回退为不过滤）
	if (hideDomestic && !hideInternational) {
		activeProxies = activeProxies.filter(p => !isDomestic(p.name));
	} else if (hideInternational && !hideDomestic) {
		activeProxies = activeProxies.filter(p => isDomestic(p.name));
	}

	// 逐阶段记录数量变化：节点「莫名少了」时，靠这一行就能定位是哪一步吃掉了
	const kwHit = normalizeExcludeKeywords(excludeKeywords).filter(kw =>
		proxies.some(p =>
			String(p.name || '')
				.toUpperCase()
				.includes(kw),
		),
	);
	log.debug('节点过滤', {
		in: proxies.length,
		afterKeywords: afterKeywords.length,
		hideDomestic,
		hideInternational,
		out: activeProxies.length,
		keywords: excludeKeywords.length,
		hitKeywords: kwHit.length ? kwHit : undefined,
	});

	if (afterKeywords.length !== proxies.length) {
		const kept = new Set(afterKeywords);
		const removed = proxies.filter(p => !kept.has(p));
		log.info('关键词过滤移除了节点', {
			removed: removed.length,
			sample: removed.slice(0, 15).map(p => p.name),
			hitKeywords: kwHit.length ? kwHit : undefined,
		});
	}

	if (proxies.length > 0 && activeProxies.length === 0) {
		const reasons = [];
		// 只列出「真的减少了节点」的条件：默认配置带了一批关键词与开关，
		// 把没起作用的也写进提示会把用户的排查方向带偏。
		if (afterKeywords.length < proxies.length) {
			const hitKeywords = kwHit;
			if (hitKeywords.length) reasons.push(`排除关键词「${hitKeywords.join('、')}」`);
		}
		if (afterKeywords.length > 0) {
			if (hideDomestic && !hideInternational) reasons.push('隐藏国内节点');
			if (hideInternational && !hideDomestic) reasons.push('隐藏国际节点');
		}
		log.warn('全部节点被过滤条件排除', {
			nodes: proxies.length,
			reasons: reasons.length ? reasons : ['（未能定位具体条件）'],
		});
		throw new AllProxiesFilteredError(
			proxies.length,
			reasons.length ? `当前过滤条件（${reasons.join(' + ')}）排除了全部节点` : null,
		);
	}

	return dedupeAndRenameReserved(activeProxies, reservedNames);
}

/** 内核内置策略名：节点不能与之同名 */
const RESERVED_PROXY_NAMES = new Set(['DIRECT', 'REJECT', 'PASS', 'GLOBAL']);

/**
 * 丢弃 target 指向不存在分组的规则。
 *
 * mihomo 对 `proxy not found` 是**零容忍**的 —— 一条规则指向已关闭的分组就会
 * 拒绝加载整份配置，用户看到的是「订阅完全不可用」，而配置看起来毫无异常。
 *
 * 分组缺失的典型来源：用户在配置页关掉了某个规则组。分组生成与规则生成各自
 * 判断开关（一个看 userGroups、一个看 ruleOptions），两边一旦不同步就会漏出
 * 悬空 target，因此这里以「实际生成的分组」为准做最终收口。
 *
 * @param {string[]} rules     形如 'DOMAIN-SUFFIX,t.me,💬 Telegram'
 * @param {Array} proxyGroups  实际生成的分组
 * @returns {string[]} 过滤后的规则
 */
function filterRulesByExistingTargets(rules, proxyGroups) {
	const valid = new Set([...proxyGroups.map(g => g.name), ...RESERVED_PROXY_NAMES]);

	// 出口由 ruleTargetOf 取（会跳过 no-resolve / src 这类修饰段），
	// 不能简单取最后一个逗号后的内容 —— 那对
	// `IP-CIDR,10.0.0.0/8,DIRECT,no-resolve` 会得出 no-resolve。
	const dropped = [];
	const kept = rules.filter(rule => {
		const text = String(rule);
		const target = ruleTargetOf(text);
		// 判定不出出口（如末段是 no-resolve 的无出口规则）→ 保留
		if (!target || valid.has(target)) return true;
		dropped.push(`${text} → ${target}`);
		return false;
	});

	if (dropped.length) {
		log.warn('规则指向不存在的分组，已移除（否则内核会拒绝加载整份配置）', {
			dropped: dropped.length,
			sample: dropped.slice(0, 5),
		});
	}
	return kept;
}

/**
 * 处理两类会让 mihomo 报错或让节点「选不中」的命名问题。
 *
 * 1. 与内置策略 / 分组同名（`DIRECT` / `REJECT` / `🚀 节点选择` …）
 *    候选列表里会同时出现分组与这个节点，内核一律解析成分组/内置策略，
 *    于是该节点永远选不中，而配置看起来完全正常 —— 极难排查。
 *    重命名成 `DIRECT (节点)` 即可区分。
 *
 * 2. 重名
 *    mihomo 不允许代理重名。单份订阅内部的重名由 parseSubscriptionList 处理，
 *    但「直接传 proxies 数组」的调用路径（如 API 的 rawContent 经 parser 后）
 *    不经过那里，所以这里再兜一次，避免漏网。
 *
 * @param {Array} proxies
 * @param {string[]} extraReserved 本次实际会生成的分组名（节点不能与之同名）
 * @returns {Array} 处理后的节点（原地修改 name）
 */
function dedupeAndRenameReserved(proxies, extraReserved = []) {
	const reserved = new Set(extraReserved.map(String));
	const seen = new Set();
	const renamed = [];
	const dropped = [];

	const out = proxies.filter(p => {
		let name = String(p.name || '').trim();
		if (!name) return true; // 无名节点交给分组阶段兜底，不在这里丢

		// 内置策略大小写不敏感；分组名是中文/emoji，精确匹配
		if (reserved.has(name) || RESERVED_PROXY_NAMES.has(name.toUpperCase())) {
			const next = `${name} (节点)`;
			if (!renamed.some(r => r.from === name)) renamed.push({ from: name, to: next });
			name = next;
			p.name = next;
		}

		if (seen.has(name)) {
			dropped.push(name);
			return false;
		}
		seen.add(name);
		return true;
	});

	if (renamed.length) {
		log.warn('节点名与内核内置策略重名，已重命名', {
			count: renamed.length,
			sample: renamed.slice(0, 5).map(r => `${r.from} → ${r.to}`),
		});
	}
	if (dropped.length) {
		log.warn('节点重名，已保留先出现的一个', {
			dropped: dropped.length,
			sample: dropped.slice(0, 5),
		});
	}
	return out;
}

/**
 * 把 OpenClash 的 include/exclude 同步到分组开关。
 * 否则被排除的规则组会留下「没有规则指向」的孤儿分组。
 * 只在调用方传了 ruleOptions 时生效，避免覆盖配置页里的分组开关。
 */
function applyRuleOptionsToGroups(userGroups, ruleOptions) {
	if (!ruleOptions || !Object.keys(ruleOptions).length) return userGroups;
	return userGroups.map(g => {
		if (!g || !g.ruleId) return g; // 内置分组不参与
		const on = ruleOptions[g.ruleId];
		if (on === undefined) return g; // 不在本次覆盖范围内
		return { ...g, enabled: on !== false };
	});
}

/**
 * 清理透传的源订阅 dns。
 *
 * 必须移除 fallback-filter.geosite：它要 GeoSite.dat，设备上没有时
 * OpenClash 的内核校验（mihomo -t）会失败，然后静默回退到下载原始订阅，
 * 表现为「填了转换地址却没转换」。该字段在 mihomo 里也已被 nameserver-policy 取代。
 * 其余 DNS 设置原样保留。
 */
function sanitizeClashDns(dns) {
	if (!dns || typeof dns !== 'object' || Array.isArray(dns)) return null;

	const out = { ...dns };
	const removed = [];

	const ff = out['fallback-filter'];
	if (ff && typeof ff === 'object' && !Array.isArray(ff)) {
		const next = { ...ff };
		for (const key of Object.keys(next)) {
			if (/^geosite/i.test(key)) {
				delete next[key];
				removed.push(`fallback-filter.${key}`);
			}
		}
		if (Object.keys(next).length) out['fallback-filter'] = next;
		else delete out['fallback-filter'];
	}

	for (const key of Object.keys(out)) {
		if (/^geosite/i.test(key)) {
			delete out[key];
			removed.push(key);
		}
	}

	if (removed.length) {
		log.warn('源订阅 DNS 含依赖 GeoSite 的字段，已移除', { removed });
	}

	return Object.keys(out).length ? out : null;
}

/**
 * 将解析后的代理节点转换为完整的 Clash YAML 配置
 * @param {Array} proxies - 代理节点数组
 * @param {Object} options - 配置选项
 * @returns {string} YAML 格式的配置字符串
 */
function convertToClash(proxies, options = {}) {
	const {
		name = 'Clash 订阅',
		// 基础配置
		mixedPort = 7890,
		allowLan = true,
		mode = 'rule',
		logLevel = 'info',
		externalController = '127.0.0.1:46011',
		secret = '',
		// DNS 配置：默认不注入，交由客户端默认行为（与直接导入等价）
		// 仅当源订阅自带 DNS 时，由调用方传入该 dns 并原样透传
		dns = null,
		// 分组和规则选项
		proxyGroupOptions = {},
		ruleOptions = {},
		// 是否包含默认规则
		includeDefaultRules = true,
	} = options;

	// 读取用户配置（options 优先级高于文件配置）
	const { userGroups, nodeFilters, excludeKeywords } = resolveUserConfig(options);
	log.debug('转换入参', {
		in: proxies.length,
		name,
		mixedPort,
		mode,
		nodeFilters,
		excludeKeywords: excludeKeywords.length,
		userGroups: userGroups.length,
		dns: dns ? '透传源订阅 dns' : '无',
	});

	const activeProxies = applyNodeFilters(
		proxies,
		nodeFilters,
		excludeKeywords,
		reservedGroupNames(userGroups),
	);

	// 生成代理分组
	// 先把 include/exclude 合并进分组开关，否则关掉的规则组会留下孤儿分组
	const groupsInUse = applyRuleOptionsToGroups(userGroups, ruleOptions);
	const proxyGroups = generateProxyGroups(activeProxies, {
		...proxyGroupOptions,
		userGroups: groupsInUse,
	});

	// 生成规则。
	//
	// 规则组开关有两个互不相干的来源：
	//   - ruleOptions  来自 OpenClash 的 include/exclude（仅 /sub 路径会传）
	//   - userGroups   来自配置页的分组开关（user-config 的 groupOverrides）
	// 早期实现让两者各自过滤，于是「在配置页关掉某个规则组」时分组没了、
	// rules 里却仍指向它 —— mihomo 会因 `proxy not found` 拒绝加载整份配置。
	// 这里统一按「实际生成的分组」做一次收口，只保留 target 确实存在的规则。
	const rawRules = includeDefaultRules
		? ruleManager.generateRules(ruleOptions)
		: ruleOptions.customRules || ['MATCH,🐟 漏网之鱼'];
	const rules = filterRulesByExistingTargets(rawRules, proxyGroups);

	// 构建完整的配置对象
	const config = {
		'mixed-port': mixedPort,
		'allow-lan': allowLan,
		'bind-address': '*',
		mode,
		'log-level': logLevel,
		'external-controller': externalController,
	};

	if (secret) {
		config.secret = secret;
	}

	// DNS 配置：透传源订阅，但清掉会让内核校验失败的字段
	const safeDns = sanitizeClashDns(dns);
	if (safeDns) {
		config.dns = safeDns;
	}

	// 代理节点
	config.proxies = activeProxies;

	// 代理分组
	config['proxy-groups'] = proxyGroups;

	// 规则
	config.rules = rules;

	// 转换为 YAML
	const yamlStr = yaml.dump(config, {
		lineWidth: -1,
		noRefs: true,
		sortKeys: false,
		quotingType: "'",
		forceQuotes: false,
	});

	// 构建结构化摘要（供前端展示）
	//
	// defaultProxy 只对 select 组有意义：Clash 以 proxies[0] 为 select 组的默认出口，
	// 而 url-test / fallback 由内核按测速或可用性自己挑，没有「默认出口」这一概念。
	// 早期实现无脑取 proxies[0]，前端于是把测速组的首个节点标成「默认出口」——
	// 用户以为可以指定，实际改了也不生效。这里改为按类型给出 null，前端据此显示说明。
	const groupList = proxyGroups.map(g => ({
		name: g.name,
		type: g.type,
		proxies: g.proxies || [],
		defaultProxy:
			g.type === 'select' ? g.defaultProxy || (g.proxies && g.proxies[0]) || null : null,
	}));

	// 追加系统规则展示（不可配置）
	groupList.push({
		name: '🏠 本地路由',
		type: 'system',
		proxies: ['DIRECT'],
		defaultProxy: 'DIRECT',
	});
	groupList.push({
		name: '🌐 GEOIP 国内直连',
		type: 'system',
		proxies: ['DIRECT'],
		defaultProxy: 'DIRECT',
	});

	const summary = {
		totalNodes: proxies.length,
		filteredNodes: activeProxies.length,
		// 活跃节点清单，供前端把节点名填进「分组默认出口」下拉框。
		// 一并返回 domestic 标记，前端就不必再抄一份国内关键词表
		// （关键词表在 config/regions.json，抄过去的那一份必然与后端漂移）。
		nodes: activeProxies.map(p => ({ name: p.name, domestic: isDomestic(p.name) })),
		// 上层 select 分组的候选清单（地区分组 + 🇨🇳 中国大陆）。
		// 两级结构下上层分组的候选是分组而非具体节点，前端「默认出口」下拉
		// 必须据此列选项，否则用户会看到「香港」但选不到。
		// 注意含中国大陆 —— 它虽不是生成器的产物，但同样是合法候选。
		regions: proxyGroups.regionNames || [],
		// 生成器产出的地区分组（不含中国大陆），供结果页/文档区分「生成器产物」。
		generatedRegions: proxyGroups.generatedRegionNames || [],
		groups: groupList,
	};

	log.info('Clash 配置生成完成', {
		totalNodes: summary.totalNodes,
		filteredNodes: summary.filteredNodes,
		groups: proxyGroups.length,
		rules: rules.length,
		yamlBytes: logger.formatBytes(Buffer.byteLength(yamlStr, 'utf-8')),
		domestic: summary.nodes.filter(n => n.domestic).length,
	});

	return { yaml: yamlStr, summary };
}

/**
 * 生成单个节点的 Surge [Proxy] 行。
 * @returns {string|null} Surge 不支持该协议时返回 null
 */
function surgeProxyLine(proxy) {
	switch (proxy.type) {
		case 'ss':
			// Surge 原生 ss 语法；早期用 custom + 外部 snippet，既依赖第三方 URL
			// 又与新版本 Surge 不兼容，等于生成一份跑不起来的配置。
			return `${proxy.name} = ss, ${proxy.server}, ${proxy.port}, encrypt-method=${proxy.cipher}, password=${proxy.password}`;
		case 'trojan': {
			let line = `${proxy.name} = trojan, ${proxy.server}, ${proxy.port}, password=${proxy.password}`;
			if (proxy.sni) line += ', sni=' + proxy.sni;
			return line;
		}
		case 'hysteria2': {
			let line = `${proxy.name} = hysteria2, ${proxy.server}, ${proxy.port}, password=${proxy.password || proxy.auth || ''}`;
			if (proxy.sni) line += ', sni=' + proxy.sni;
			if (proxy['skip-cert-verify']) line += ', skip-cert-verify=true';
			return line;
		}
		case 'snell': {
			let line = `${proxy.name} = snell, ${proxy.server}, ${proxy.port}, psk=${proxy.psk}`;
			if (proxy.version) line += ', version=' + proxy.version;
			return line;
		}
		case 'socks5': {
			let line = `${proxy.name} = socks5, ${proxy.server}, ${proxy.port}`;
			if (proxy.username) line += ', username=' + proxy.username;
			if (proxy.password) line += ', password=' + proxy.password;
			if (proxy.tls) line += ', tls=true';
			if (proxy.sni) line += ', sni=' + proxy.sni;
			return line;
		}
		case 'http': {
			let line = `${proxy.name} = http, ${proxy.server}, ${proxy.port}`;
			if (proxy.username) line += ', username=' + proxy.username;
			if (proxy.password) line += ', password=' + proxy.password;
			if (proxy.tls) line += ', tls=true';
			if (proxy.sni) line += ', sni=' + proxy.sni;
			return line;
		}
		default:
			// 只输出语法确定的协议。vmess / vless / ssr / anytls / hysteria(v1) /
			// shadowquic 是 Surge 不支持的；tuic / wireguard 在 Surge 里的写法与
			// Clash 字段并不一一对应（WireGuard 是 section 引用语法），
			// 硬套会生成一份 Surge 加载不了的配置 —— 宁可少节点，也不给坏结果。
			return null;
	}
}

/**
 * 将配置转换为 Surge 格式（简化版）
 *
 * 与 convertToClash 共用同一套用户配置解析与节点过滤：
 * 过滤/分组策略必须与 Clash 输出一致，否则同一个订阅在两个入口会得到
 * 不同的节点集合与分组默认项，用户无从判断哪个才是自己要的。
 */
function convertToSurge(proxies, options = {}) {
	const { userGroups, nodeFilters, excludeKeywords } = resolveUserConfig(options);
	const activeProxies = applyNodeFilters(
		proxies,
		nodeFilters,
		excludeKeywords,
		reservedGroupNames(userGroups),
	);

	const lines = [];
	lines.push('#!name = ' + (options.name || 'Clash 订阅'));
	lines.push('');
	lines.push('[General]');
	lines.push('loglevel = notify');
	lines.push(
		'skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local',
	);
	lines.push('dns-server = 223.5.5.5, 119.29.29.29');
	lines.push('');

	lines.push('[Proxy]');
	// 只收集真正写入 [Proxy] 的节点：Surge 不支持的协议被跳过，
	// 若分组仍引用它们会产生悬空引用，Surge 会因未知代理名报错。
	const surgeProxies = [];
	const skippedTypes = {};
	for (const proxy of activeProxies) {
		const line = surgeProxyLine(proxy);
		if (!line) {
			skippedTypes[proxy.type] = (skippedTypes[proxy.type] || 0) + 1;
			continue;
		}
		lines.push(line);
		surgeProxies.push(proxy);
	}
	if (Object.keys(skippedTypes).length) {
		// 不静默：用户看到「节点少了一大半」时，日志里能直接找到原因
		log.warn('Surge 不支持的协议已跳过', {
			skipped: skippedTypes,
			kept: surgeProxies.length,
			total: activeProxies.length,
		});
	}
	lines.push('');

	lines.push('[Proxy Group]');
	// 与 convertToClash 一致：先合并 include/exclude，避免孤儿分组
	const groups = generateProxyGroups(surgeProxies, {
		...(options.proxyGroupOptions || {}),
		userGroups: applyRuleOptionsToGroups(userGroups, options.ruleOptions),
	});
	for (const group of groups) {
		const proxyList = group.proxies.join(', ');
		if (group.type === 'select') {
			lines.push(`${group.name} = select, ${proxyList}`);
		} else if (group.type === 'url-test') {
			lines.push(
				`${group.name} = url-test, ${proxyList}, url=${group.url || 'http://www.gstatic.com/generate_204'}, interval=${group.interval || 300}`,
			);
		}
	}
	lines.push('');

	lines.push('[Rule]');
	const rawRules = ruleManager.generateRules(options.ruleOptions || {});
	// 与 Clash 输出同一套收口：规则不能指向未生成的分组，
	// 否则 Surge 会因为未知代理名而报错（等同于内核拒绝加载）。
	const rules = filterRulesByExistingTargets(rawRules, groups).map(rule =>
		// Surge 的兜底规则是 FINAL，MATCH 是 Clash 的写法
		/^MATCH,/i.test(rule) ? rule.replace(/^MATCH,/i, 'FINAL,') : rule,
	);
	for (const rule of rules) {
		lines.push(rule);
	}

	return lines.join('\n');
}

module.exports = {
	convertToClash,
	convertToSurge,
};
