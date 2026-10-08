/**
 * 节点有效性校验
 *
 * 解析器只负责「把 URI 拆成字段」，不负责判断字段是否够用 —— 于是
 * `trojan://pw@host`（缺端口）会得到 `port: null`，`vmess://` 里缺 `id`
 * 会得到 `uuid: undefined`。这类节点一旦写进配置，mihomo 会因缺少必需字段
 * **拒绝加载整份配置**，用户看到的是「订阅全部失效」，而不是「某个节点有问题」。
 *
 * 因此在解析与转换之间加一道统一校验：不合格的节点直接丢弃并留下日志。
 * 放在这里而不是各个解析器里，是因为「哪些字段是必需的」由协议本身决定，
 * 散落在 11 个解析器里必然漏改；集中一处才好与 mihomo 的 schema 对齐。
 */

/**
 * 各协议的必需字段（缺一不可）。
 *
 * 只列 mihomo 会因缺失而**拒绝加载**的字段：
 *   - server / port 是所有协议的连接基础
 *   - vmess / vless 靠 uuid 鉴权，tuic 靠 uuid+password，其余靠 password 或 psk
 * 可选字段（sni / network / alpn …）不在此列，缺失时内核会用默认值。
 */
const REQUIRED_FIELDS = {
	vmess: ['server', 'port', 'uuid'],
	vless: ['server', 'port', 'uuid'],
	trojan: ['server', 'port', 'password'],
	ss: ['server', 'port', 'cipher', 'password'],
	ssr: ['server', 'port', 'cipher', 'password'],
	hysteria: ['server', 'port'],
	hysteria2: ['server', 'port', 'password'],
	anytls: ['server', 'port', 'password'],
	tuic: ['server', 'port', 'uuid', 'password'],
	snell: ['server', 'port', 'psk'],
	socks5: ['server', 'port'],
	http: ['server', 'port'],
	wireguard: ['server', 'port', 'private-key', 'public-key'],
	shadowquic: ['server', 'port', 'password'],
};

/** 空值判定：null / undefined / 空串 / NaN 都算缺失（0 与 false 是合法值） */
function isEmpty(v) {
	if (v === null || v === undefined) return true;
	if (typeof v === 'string' && !v.trim()) return true;
	if (typeof v === 'number' && !Number.isFinite(v)) return true;
	return false;
}

/**
 * 校验单个节点是否可用。
 *
 * @param {Object} proxy 解析器产出的节点
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function validateProxy(proxy) {
	if (!proxy || typeof proxy !== 'object') return { ok: false, reason: '节点为空' };

	const type = String(proxy.type || '');
	if (!type) return { ok: false, reason: '缺少 type' };

	// 端口必须是 1~65535 的整数：`parseInt('')` 得到 NaN、`parseInt('abc')` 同理，
	// 而 `parseInt(undefined)` 也是 NaN —— 都在这条规则下被拦下。
	const port = Number(proxy.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, reason: `端口非法（${proxy.port}）` };
	}

	const required = REQUIRED_FIELDS[type] || ['server', 'port'];
	const missing = required.filter(f => isEmpty(proxy[f]));
	if (missing.length) return { ok: false, reason: `缺少必需字段 ${missing.join('、')}` };

	// server 里出现空白 / 斜杠说明解析错位（如把整段 URL 当成了主机名）
	const server = String(proxy.server);
	if (/[\s/]/.test(server)) return { ok: false, reason: `server 非法（${server}）` };

	return { ok: true };
}

/**
 * 过滤节点数组，丢弃无效项。
 *
 * @param {Array} proxies
 * @param {Function} [onDrop] 每个被丢弃的节点回调 (proxy, reason)
 * @returns {Array} 有效节点
 */
function filterValidProxies(proxies, onDrop) {
	const out = [];
	for (const p of Array.isArray(proxies) ? proxies : []) {
		const r = validateProxy(p);
		if (r.ok) out.push(p);
		else if (onDrop) onDrop(p, r.reason);
	}
	return out;
}

module.exports = { validateProxy, filterValidProxies, REQUIRED_FIELDS };
