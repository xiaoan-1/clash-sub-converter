/**
 * Snell 解析
 * 格式: snell://psk@server:port?params#name
 */
function parseSnell(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'snell',
    server: url.hostname,
    port: parseInt(url.port),
    psk: decodeURIComponent(url.username),
    udp: true
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
