/**
 * WireGuard 解析
 * 格式: wireguard://privateKey@server:port?publicKey=…&ip=…&mtu=…#name
 */
function parseWireGuard(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'wireguard',
    server: url.hostname,
    port: parseInt(url.port),
    'private-key': decodeURIComponent(url.username),
    udp: true
  };

  const publicKey = url.searchParams.get('publicKey') || url.searchParams.get('public-key') || url.searchParams.get('pubkey');
  if (publicKey) proxy['public-key'] = publicKey;

  const ip = url.searchParams.get('ip') || url.searchParams.get('address');
  if (ip) proxy.ip = ip;

  const ipv6 = url.searchParams.get('ipv6');
  if (ipv6) proxy.ipv6 = ipv6;

  const mtu = url.searchParams.get('mtu');
  if (mtu) proxy.mtu = parseInt(mtu);

  const dns = url.searchParams.get('dns');
  if (dns) proxy.dns = dns.split(',').map(s => s.trim()).filter(Boolean);

  const preSharedKey = url.searchParams.get('psk') || url.searchParams.get('pre-shared-key');
  if (preSharedKey) proxy['pre-shared-key'] = preSharedKey;

  const reserved = url.searchParams.get('reserved');
  if (reserved) {
    proxy.reserved = reserved.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  }

  return proxy;
}

module.exports = { parseWireGuard };
