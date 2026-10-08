/**
 * ShadowQUIC 解析
 * 格式: shadowquic://user:pass@server:port?params#name
 */
const { parseNodeUrl } = require('./utils');

function parseShadowQUIC(link) {
	const parsed = parseNodeUrl(link);
	if (!parsed) return null;
	const { url, name } = parsed;

	const proxy = {
		name,
		type: 'shadowquic',
		server: url.hostname,
		port: parseInt(url.port),
		username: decodeURIComponent(url.username || ''),
		password: decodeURIComponent(url.password || ''),
		udp: true,
	};

	const sni = url.searchParams.get('sni');
	if (sni) proxy.sni = sni;

	const alpn = url.searchParams.get('alpn');
	if (alpn)
		proxy.alpn = alpn
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const quicVersions =
		url.searchParams.get('quic-versions') || url.searchParams.get('quic_versions');
	if (quicVersions)
		proxy['quic-versions'] = quicVersions
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const congestion =
		url.searchParams.get('congestion-controller') || url.searchParams.get('congestion_control');
	if (congestion) proxy['congestion-controller'] = congestion;

	return proxy;
}

module.exports = { parseShadowQUIC };
