/**
 * TUIC 解析
 * 格式: tuic://uuid:password@server:port?params#name   （TUIC V5）
 *       tuic://token@server:port?params#name           （TUIC V4）
 */
const { parseNodeUrl } = require('./utils');

function parseTUIC(link) {
	const parsed = parseNodeUrl(link);
	if (!parsed) return null;
	const { url, name, server, username, password } = parsed;

	const proxy = {
		name,
		type: 'tuic',
		server,
		port: parseInt(url.port),
		udp: true,
	};

	// userinfo:uuid:password 由 URL 规范自动拆成 username/password（V5）；
	// 只有单个 token 时 username 承载全部内容（V4）
	if (username && password) {
		proxy.uuid = username;
		proxy.password = password;
	} else if (username) {
		proxy.token = username;
	}

	const sni = url.searchParams.get('sni');
	if (sni) proxy.sni = sni;

	const alpn = url.searchParams.get('alpn');
	if (alpn)
		proxy.alpn = alpn
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const congestion =
		url.searchParams.get('congestion_control') || url.searchParams.get('congestion-controller');
	if (congestion) proxy['congestion-controller'] = congestion;

	const udpRelay =
		url.searchParams.get('udp_relay_mode') || url.searchParams.get('udp-relay-mode');
	if (udpRelay) proxy['udp-relay-mode'] = udpRelay;

	const skipCert = url.searchParams.get('allowInsecure') || url.searchParams.get('insecure');
	if (skipCert === '1' || skipCert === 'true') proxy['skip-cert-verify'] = true;

	return proxy;
}

module.exports = { parseTUIC };
