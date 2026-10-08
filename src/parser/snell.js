/**
 * Snell 解析
 * 格式: snell://psk@server:port?params#name
 */
const { parseNodeUrl } = require('./utils');

function parseSnell(link) {
	const parsed = parseNodeUrl(link);
	if (!parsed) return null;
	const { url, name } = parsed;

	const proxy = {
		name,
		type: 'snell',
		server: url.hostname,
		port: parseInt(url.port),
		psk: decodeURIComponent(url.username),
		udp: true,
	};

	const version = url.searchParams.get('version');
	if (version) proxy.version = parseInt(version);

	// 混淆：obfs=…&obfs-host=…
	const obfs = url.searchParams.get('obfs');
	const obfsHost = url.searchParams.get('obfs-host') || url.searchParams.get('obfs_host');
	if (obfs) {
		proxy['obfs-opts'] = {
			mode: obfs,
			...(obfsHost ? { host: obfsHost } : {}),
		};
	}

	return proxy;
}

module.exports = { parseSnell };
