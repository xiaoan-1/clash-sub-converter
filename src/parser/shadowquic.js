/**
 * ShadowQUIC 解析
 * 格式: shadowquic://user:pass@server:port?params#name
 */
function parseShadowQUIC(link) {
	const url = new URL(link);
	const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

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
