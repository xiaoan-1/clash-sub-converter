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

module.exports = { safeDecodeURIComponent, parseSsUserInfo };
