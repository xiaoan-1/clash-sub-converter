/**
 * 订阅 URL 安全校验（SSRF 防护）
 *
 * 订阅地址由调用方提供（`/sub?url=`、`/api/convert` 的 `urls`），是**外部可控输入**。
 * 若不加校验，攻击者可让本服务请求任意地址：
 *   - 云元数据服务  http://169.254.169.254/latest/meta-data/   （可窃取实例凭据）
 *   - 内网服务      http://192.168.1.1/admin、http://127.0.0.1:6379
 *   - 内网端口扫描  （按响应时间 / 错误码差异探测存活）
 *
 * 因此这里做两层限制：
 *   1. 协议白名单：只允许 http / https
 *   2. 地址黑名单：拒绝回环、私有网段、link-local、以及 IPv6 的对应网段
 *
 * 例外：本机部署时常把订阅放在同一台机器的其他端口，或局域网 NAS 上，
 * 这种合法场景由环境变量 `ALLOW_PRIVATE_URL=1` 放行（默认关闭）。
 */

const net = require('net');
const dns = require('dns');

/** 是否允许请求内网 / 回环地址（默认关闭，设 ALLOW_PRIVATE_URL=1 开启） */
function allowPrivateUrl() {
	const v = String(process.env.ALLOW_PRIVATE_URL || '')
		.trim()
		.toLowerCase();
	return v === '1' || v === 'true' || v === 'yes';
}

/** 判断 IPv4 是否属于私有 / 保留网段 */
function isPrivateIPv4(ip) {
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
		return false;
	}
	const [a, b] = parts;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 127) return true; // 127.0.0.0/8 回环
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local（云元数据）
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a >= 224) return true; // 组播 / 保留
	return false;
}

/**
 * 把 IPv6 字面量展开成 16 字节数组。
 *
 * 必须真正展开，不能靠字符串前缀判断：攻击者用 `[::ffff:169.254.169.254]`
 * 就能绕过 `startsWith('fe80:')` 这类前缀检查（实测 Node 的 URL 会把它
 * 规范化成 `[::ffff:a9fe:a9fe]`，肉眼已看不出是内网地址）。
 *
 * @returns {number[]|null} 解析失败返回 null
 */
function ipv6ToBytes(ip) {
	let s = String(ip).toLowerCase().split('%')[0]; // 去掉 zone id（fe80::1%eth0）
	if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);

	const halves = s.split('::');
	if (halves.length > 2) return null;

	/** 末尾内嵌的 IPv4（::ffff:1.2.3.4）拆成两组 16 位 */
	const toGroups = part => {
		const groups = part ? part.split(':') : [];
		const last = groups[groups.length - 1];
		if (last && last.includes('.')) {
			const v4 = last.split('.').map(Number);
			if (v4.length !== 4 || v4.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
				return null;
			}
			groups.splice(
				groups.length - 1,
				1,
				((v4[0] << 8) | v4[1]).toString(16),
				((v4[2] << 8) | v4[3]).toString(16),
			);
		}
		return groups;
	};

	const head = toGroups(halves[0]);
	const tail = halves.length === 2 ? toGroups(halves[1]) : [];
	if (!head || !tail) return null;

	let groups;
	if (halves.length === 2) {
		const missing = 8 - head.length - tail.length;
		if (missing < 0) return null;
		groups = [...head, ...Array(missing).fill('0'), ...tail];
	} else {
		groups = head;
	}
	if (groups.length !== 8) return null;

	const bytes = [];
	for (const g of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
		const n = parseInt(g, 16);
		bytes.push((n >> 8) & 0xff, n & 0xff);
	}
	return bytes;
}

/** 判断 IPv6 是否属于回环 / link-local / ULA / 组播 / 内嵌 IPv4 的内网段 */
function isPrivateIPv6(ip) {
	const b = ipv6ToBytes(ip);
	// 解析不了就当公网：交给 DNS 校验与连接阶段，不在这里误拦合法订阅
	if (!b) return false;

	// :: 与 ::1
	if (b.slice(0, 15).every(x => x === 0) && b[15] <= 1) return true;
	// fe80::/10 link-local
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;
	// fc00::/7 唯一本地地址
	if ((b[0] & 0xfe) === 0xfc) return true;
	// ff00::/8 组播
	if (b[0] === 0xff) return true;

	const embedded = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
	const zeroPrefix = n => b.slice(0, n).every(x => x === 0);

	// ::ffff:0:0/96 IPv4-mapped（[::ffff:169.254.169.254] 走这条）
	if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4(embedded());
	// ::a.b.c.d IPv4-compatible（已废弃，但仍可能被用作绕过）
	if (zeroPrefix(12)) return isPrivateIPv4(embedded());
	// 64:ff9b::/96 NAT64
	if (
		b[0] === 0x00 &&
		b[1] === 0x64 &&
		b[2] === 0xff &&
		b[3] === 0x9b &&
		b.slice(4, 12).every(x => x === 0)
	) {
		return isPrivateIPv4(embedded());
	}
	// 2002::/16 6to4：内嵌 IPv4 在 2~5 字节
	if (b[0] === 0x20 && b[1] === 0x02) {
		return isPrivateIPv4(`${b[2]}.${b[3]}.${b[4]}.${b[5]}`);
	}
	return false;
}

/**
 * 判断主机名是否明显指向内网（含 localhost 与常见内网后缀）。
 * @param {string} host URL.hostname（Node 会保留 IPv6 的方括号）
 */
function isPrivateHostname(host) {
	const h = String(host || '')
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	if (!h) return false;
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home')) return true;

	// 用 net.isIP 判类型，而不是「像不像点分十进制」：URL 会先把
	// `2130706433` / `0x7f.1` 这类写法规范化成 127.0.0.1（实测），
	// 因此到这里若仍是 IP 字面量，一定已是标准形式。
	const version = net.isIP(h);
	if (version === 4) return isPrivateIPv4(h);
	if (version === 6) return isPrivateIPv6(h);
	return false;
}

/**
 * 校验订阅 URL 的协议与主机（同步部分）。
 *
 * 只覆盖「URL 本身就是内网地址」这一层；域名解析到内网、以及重定向到内网
 * 分别由 assertSubscriptionHostAllowed() 与 fetcher 的逐跳校验处理。
 *
 * @param {string} raw 原始 URL（可能来自查询串，尚未 decode）
 * @returns {{ok:true, url:string} | {ok:false, reason:string}}
 */
function validateSubscriptionUrl(raw) {
	const s = String(raw == null ? '' : raw).trim();
	if (!s) return { ok: false, reason: '订阅地址为空' };

	let url;
	try {
		url = new URL(s);
	} catch {
		return { ok: false, reason: '订阅地址格式非法' };
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { ok: false, reason: `仅支持 http / https 订阅地址（收到 ${url.protocol}）` };
	}

	if (!allowPrivateUrl() && isPrivateHostname(url.hostname)) {
		return {
			ok: false,
			reason: '拒绝请求内网 / 回环地址（如确需，请设置 ALLOW_PRIVATE_URL=1）',
		};
	}

	return { ok: true, url: url.toString() };
}

/**
 * 域名解析后再校验一次（异步部分）。
 *
 * 攻击者可以注册一个解析到 127.0.0.1 / 169.254.169.254 的域名（DNS rebinding
 * 的简化版）绕开纯字面量检查，因此这里把域名解析成 IP 再判一遍。
 *
 * 解析失败时**放行**而不是拒绝：NXDOMAIN 说明域名本身不可用，交给 fetch
 * 报出更准确的错误（ENOTFOUND 已有专门的中文提示）；在这里拦下来反而会把
 * 「域名写错」误报成「疑似 SSRF」。
 *
 * @param {string} url
 * @throws {Error} 解析结果中存在内网地址时抛出（带 hint / stage）
 */
async function assertSubscriptionHostAllowed(url) {
	if (allowPrivateUrl()) return;

	let hostname;
	try {
		hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
	} catch {
		return;
	}
	if (!hostname || net.isIP(hostname)) return; // IP 字面量已在同步校验里判过

	let addrs;
	try {
		addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
	} catch {
		return;
	}

	for (const a of addrs || []) {
		const priv = a.family === 6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address);
		if (priv) {
			const err = new Error(`域名 ${hostname} 解析到内网地址 ${a.address}，已拒绝`);
			err.hint =
				'订阅域名不允许指向内网 / 回环 / 云元数据地址（如确需，请设置 ALLOW_PRIVATE_URL=1）';
			err.stage = 'guard';
			err.failReason = err.message;
			throw err;
		}
	}
}

module.exports = { validateSubscriptionUrl, assertSubscriptionHostAllowed };
