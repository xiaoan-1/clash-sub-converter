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

/** 判断主机名是否明显指向内网（含 localhost 与常见内网后缀） */
function isPrivateHostname(host) {
	const h = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (h === 'localhost' || h.endsWith('.localhost')) return true;
	if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home')) return true;
	// IPv6 回环 / link-local / 唯一本地地址
	if (h === '::1' || h === '::') return true;
	if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
	// 纯 IPv4 字面量
	if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return isPrivateIPv4(h);
	return false;
}

/**
 * 校验订阅 URL 是否允许请求。
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

module.exports = { validateSubscriptionUrl, isPrivateIPv4, isPrivateHostname, allowPrivateUrl };
