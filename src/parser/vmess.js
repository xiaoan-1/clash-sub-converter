/**
 * VMess 解析
 * 格式: vmess://base64({json})
 */
const { base64Decode, safeJsonParse } = require('../utils/encoding');

function parseVmess(link) {
	const b64 = link.replace('vmess://', '');
	const json = safeJsonParse(base64Decode(b64));
	if (!json || !json.add || !json.port) return null;

	const proxy = {
		name: json.ps || `${json.add}:${json.port}`,
		type: 'vmess',
		server: json.add,
		port: parseInt(json.port),
		uuid: json.id,
		alterId: parseInt(json.aid || 0),
		cipher: 'auto',
		udp: true,
	};

	// 网络传输层
	const net = json.net || 'tcp';
	if (net === 'ws') {
		proxy.network = 'ws';
		proxy['ws-opts'] = {
			path: json.path || '/',
			headers: { Host: json.host || '' },
		};
	} else if (net === 'h2') {
		proxy.network = 'h2';
		proxy['h2-opts'] = {
			host: [json.host || ''],
			path: json.path || '/',
		};
	} else if (net === 'grpc') {
		proxy.network = 'grpc';
		proxy['grpc-opts'] = {
			'grpc-service-name': json.path || '',
		};
	} else if (net === 'http') {
		proxy.network = 'http';
		proxy['http-opts'] = {
			path: [json.path || '/'],
			method: 'POST',
			headers: {
				Connection: ['keep-alive'],
				Host: [json.host || ''],
			},
		};
	}

	// TLS
	if (json.tls === 'tls') {
		proxy.tls = true;
		if (json.sni) {
			proxy.sni = json.sni;
		}
		if (json.alpn) {
			proxy.alpn = json.alpn.split(',');
		}
		if (json.allowInsecure === '1' || json.allowInsecure === 1) {
			proxy['skip-cert-verify'] = true;
		}
	}

	return proxy;
}

module.exports = { parseVmess };
