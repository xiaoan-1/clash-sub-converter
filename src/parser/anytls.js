/**
 * AnyTLS 解析
 * 格式: anytls://password@server:port?params#name
 */
function parseAnyTLS(link) {
	const url = new URL(link);
	const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

	const proxy = {
		name,
		type: 'anytls',
		server: url.hostname,
		port: parseInt(url.port),
		password: url.username,
		udp: true,
	};

	const sni = url.searchParams.get('sni') || url.searchParams.get('peer');
	if (sni) proxy.sni = sni;

	const skipCert = url.searchParams.get('allowInsecure') || url.searchParams.get('insecure');
	if (skipCert === '1' || skipCert === 'true') proxy['skip-cert-verify'] = true;

	return proxy;
}

module.exports = { parseAnyTLS };
