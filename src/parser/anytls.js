/**
 * AnyTLS 解析
 * 格式: anytls://password@server:port?params#name
 */
const { parseNodeUrl } = require('./utils');

function parseAnyTLS(link) {
	const parsed = parseNodeUrl(link);
	if (!parsed) return null;
	const { url, name } = parsed;

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
