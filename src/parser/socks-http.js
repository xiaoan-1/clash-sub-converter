/**
 * SOCKS5 / HTTP 通用代理解析（字段结构几乎一致，合并管理）
 */

/**
 * 解析 SOCKS5 链接
 * 格式: socks5://user:pass@server:port?params#name
 */
function parseSocks(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'socks5',
    server: url.hostname,
    port: parseInt(url.port),
    udp: true
  };

  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);

  const tls = url.searchParams.get('tls');
  if (tls === '1' || tls === 'true') proxy.tls = true;

  const sni = url.searchParams.get('sni');
  if (sni) proxy.sni = sni;

  const skipCert = url.searchParams.get('skip-cert-verify') || url.searchParams.get('allowInsecure');
  if (skipCert === '1' || skipCert === 'true') proxy['skip-cert-verify'] = true;

  return proxy;
}

/**
 * 解析 HTTP 代理链接
 * 格式: http://user:pass@server:port#name
 *       https://user:pass@server:port?tls=true#name
 */
function parseHttp(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;

  const proxy = {
    name,
    type: 'http',
    server: url.hostname,
    port: parseInt(url.port || (url.protocol === 'https:' ? 443 : 80)),
    udp: true
  };

  if (url.username) proxy.username = decodeURIComponent(url.username);
  if (url.password) proxy.password = decodeURIComponent(url.password);

  // https:// 前缀默认 TLS
  if (url.protocol === 'https:') proxy.tls = true;

  const tls = url.searchParams.get('tls');
  if (tls === '1' || tls === 'true') proxy.tls = true;

  const sni = url.searchParams.get('sni');
  if (sni) proxy.sni = sni;

  const skipCert = url.searchParams.get('skip-cert-verify') || url.searchParams.get('allowInsecure');
  if (skipCert === '1' || skipCert === 'true') proxy['skip-cert-verify'] = true;

  return proxy;
}

module.exports = { parseSocks, parseHttp };
