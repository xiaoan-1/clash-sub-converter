/**
 * VLESS 解析
 * 格式: vless://uuid@server:port?params#name
 *
 * 注意 mihomo 的 VLESS 与 VMess 字段并不通用：
 *   - 没有 alterId / cipher，带上去会被内核判为不支持的字段
 *   - SNI 用 servername，不是 sni
 *   - XTLS 流控用 flow
 */
const { parseNodeUrl } = require('./utils');

function parseVless(link) {
	const parsed = parseNodeUrl(link);
	if (!parsed) return null;
	const { url, name } = parsed;

	const proxy = {
		name,
		type: 'vless',
		server: url.hostname,
		port: parseInt(url.port),
		uuid: decodeURIComponent(url.username),
		udp: true,
	};

	// XTLS 流控（xtls-rprx-vision 等），不设置则内核按普通 VLESS 处理
	const flow = url.searchParams.get('flow');
	if (flow) proxy.flow = flow;

	// 传输层安全：tls / reality / none
	const security = url.searchParams.get('security');
	if (security === 'tls' || security === 'reality') proxy.tls = true;

	// VLESS 的 SNI 字段名是 servername（不是 sni）
	const sni = url.searchParams.get('sni') || url.searchParams.get('peer');
	if (sni) proxy.servername = sni;

	const fingerprint = url.searchParams.get('fp');
	if (fingerprint) proxy['client-fingerprint'] = fingerprint;

	// ALPN：vless 链接里是逗号分隔的字符串，Clash 要数组
	const alpn = url.searchParams.get('alpn');
	if (alpn)
		proxy.alpn = alpn
			.split(',')
			.map(s => s.trim())
			.filter(Boolean);

	const insecure = url.searchParams.get('insecure') || url.searchParams.get('allowInsecure');
	if (insecure === '1' || insecure === 'true') proxy['skip-cert-verify'] = true;

	// Reality：pbk 为公钥，sid 为 short-id
	if (security === 'reality') {
		const publicKey = url.searchParams.get('pbk');
		if (publicKey) {
			const realityOpts = { 'public-key': publicKey };
			const shortId = url.searchParams.get('sid');
			if (shortId) realityOpts['short-id'] = shortId;
			proxy['reality-opts'] = realityOpts;
		}
	}

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
	} else if (transport === 'h2') {
		proxy.network = 'h2';
		proxy['h2-opts'] = {
			host: [url.searchParams.get('host') || ''],
			path: url.searchParams.get('path') || '/',
		};
	} else if (transport) {
		proxy.network = transport;
	}

	return proxy;
}

module.exports = { parseVless };
