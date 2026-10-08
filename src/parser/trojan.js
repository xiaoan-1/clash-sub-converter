/**
 * Trojan 解析
 * 格式: trojan://password@server:port?params#name
 */
function parseTrojan(link) {
	const url = new URL(link);
	const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

	const proxy = {
		name,
		type: 'trojan',
		server: url.hostname,
		port: parseInt(url.port),
		password: url.username,
		udp: true,
	};

	const sni = url.searchParams.get('sni') || url.searchParams.get('peer');
	if (sni) proxy.sni = sni;

	const skipCert = url.searchParams.get('allowInsecure');
	if (skipCert === '1') proxy['skip-cert-verify'] = true;

	// 传输层
	const transport = url.searchParams.get('type');
	if (transport === 'ws') {
		proxy.network = 'ws';
		proxy['ws-opts'] = {
			path: url.searchParams.get('path') || '/',
			headers: { Host: url.searchParams.get('host') || '' },
		};
	} else if (transport === 'grpc') {
		proxy.network = 'grpc';
		proxy['grpc-opts'] = {
			'grpc-service-name': url.searchParams.get('serviceName') || '',
		};
	}

	return proxy;
}

module.exports = { parseTrojan };
