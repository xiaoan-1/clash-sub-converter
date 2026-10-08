/**
 * 协议解析器共用工具
 */
const { base64Decode } = require('../utils/encoding');

/**
 * decodeURIComponent 的安全包装。
 * 用户给的名称里常有裸 `%`（如「100% 稳定」），decodeURIComponent 会抛 URIError；
 * 那样会让整条节点被丢弃，而这里完全可以退回原字符串。
 */
function safeDecodeURIComponent(str) {
	try {
		return decodeURIComponent(str);
	} catch {
		return str;
	}
}

/**
 * 把 `scheme://...` 节点链接解析成 URL，并取出节点名。
 *
 * 各协议解析器原本各写一遍 `new URL(link)` + `decodeURIComponent(url.hash)`，
 * 两处都会抛异常且都没兜底：
 *   - `new URL()` 对 `trojan://pw@:443` 这类畸形串抛 `Invalid URL`
 *   - `decodeURIComponent()` 对名称里的裸 `%`（如 `#100%稳定`）抛 `URI malformed`
 * 异常会被 parseSubscription 的 try/catch 兜住并丢弃该节点 —— 结果是「订阅里
 * 有这条节点，转换后却凭空少了」，且日志里只有一句 URI malformed 看不出是哪条。
 *
 * @param {string} link 原始节点链接
 * @returns {{url:URL, name:string}|null} 无法解析成 URL 时返回 null
 */
function parseNodeUrl(link) {
	const s = String(link);
	let url;
	try {
		url = new URL(s);
	} catch {
		return null;
	}
	// 主机名是后续组装配置的必需项，缺失时直接判定为无效
	if (!url.hostname) return null;

	// 名称从**原始串**里取，不能用 url.hash：URL 解析会把裸 `%` 转义成 `%25`、
	// 又把中文编码成 `%XX`，两者混在一起无法还原
	// （`#100%稳定` → `#100%%E7%A8%B3%E5%AE%9A`，解出来是乱码）。
	// 直接取原始 fragment 再宽容解码才是对的：
	//   已编码 `#%E5%8F%B0%E6%B9%BE` → 解出「台湾」
	//   未编码 `#100%稳定`          → 裸 % 解不出 → 原样保留「100%稳定」
	const hashIdx = s.indexOf('#');
	const raw = hashIdx >= 0 ? s.slice(hashIdx + 1) : '';
	const name = safeDecodeURIComponent(raw).trim() || `${url.hostname}:${url.port}`;
	return { url, name };
}

/**
 * 解析 SS 的 userinfo，得到 { method, password }。
 *
 * SIP002 规定 userinfo 既可以是 URL-safe base64，也可以是 URL 编码的明文，两种都得支持：
 *   ss://<base64(aes-256-gcm:password)>@host:port
 *   ss://aes-256-gcm:password@host:port
 * 明文必然含冒号，而 base64 字符集（A-Za-z0-9+/-_）不含冒号，可据此区分。
 *
 * 密码允许含冒号（如 `pa:ss:word`），所以只能按「第一个冒号」切分 ——
 * 用 split(':') 只取前两段会把密码截断成 `pa`，进而连不上节点。
 * 加密方式名称本身不含冒号（aes-256-gcm、chacha20-ietf-poly1305 …），该前提由 SS 协议保证。
 *
 * @returns {{method:string, password:string}|null} 辨认不出「加密方式:密码」时返回 null
 */
function parseSsUserInfo(userinfo) {
	const decoded = userinfo.includes(':')
		? safeDecodeURIComponent(userinfo)
		: base64Decode(userinfo);
	const sep = decoded.indexOf(':');
	// 既非明文也非合法 base64 时拿不到冒号：与其产出一个密码/加密方式错乱的节点，不如丢弃
	if (sep === -1) return null;
	return {
		method: decoded.substring(0, sep).trim(),
		password: decoded.substring(sep + 1),
	};
}

module.exports = { safeDecodeURIComponent, parseSsUserInfo, parseNodeUrl };
