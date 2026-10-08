/**
 * Hysteria / Hysteria2 解析（同族 QUIC 协议）
 */

/**
 * 解析 Hysteria2 链接
 * 格式: hysteria2://password@server:port?params#name
 */
function parseHysteria2(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'hysteria2',
    server: url.hostname,
    port: parseInt(url.port),
    password: url.username,
    up: url.searchParams.get('up') || '20 Mbps',
    down: url.searchParams.get('down') || '50 Mbps',
    udp: true
  };

  const sni = url.searchParams.get('sni');
  if (sni) proxy.sni = sni;

  const skipCert = url.searchParams.get('insecure');
  if (skipCert === '1') proxy['skip-cert-verify'] = true;

  return proxy;
}

/**
 * 解析 Hysteria 1 链接
 * 格式: hysteria://auth@server:port?params#name
 * 认证方式：auth-str（密码）或 auth（base64 的用户名:密码）
 */
function parseHysteria(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'hysteria',
    server: url.hostname,
    port: parseInt(url.port),
    up: url.searchParams.get('up') || '20 Mbps',
    down: url.searchParams.get('down') || '50 Mbps',
    udp: true
  };

  // 认证：auth-str=密码；auth=base64(user:pass)；或 userinfo 中的用户名
  const authStr = url.searchParams.get('auth-str') || url.searchParams.get('auth_str');
  if (authStr) {
    proxy['auth-str'] = authStr;
  } else {
    const auth = url.searchParams.get('auth');
    if (auth) {
      proxy.auth = auth;
    } else if (url.username) {
      proxy['auth-str'] = url.username;
    }
  }

  // 混淆（obfs）参数
  const obfs = url.searchParams.get('obfs');
  if (obfs) proxy.obfs = obfs;

  // 传输协议：udp / wechat-video / faketcp
  const protocol = url.searchParams.get('protocol');
  if (protocol) proxy.protocol = protocol;

  const alpn = url.searchParams.get('alpn');
  if (alpn) proxy.alpn = alpn.split(',').map(s => s.trim()).filter(Boolean);

  const sni = url.searchParams.get('sni') || url.searchParams.get('peer');
  if (sni) proxy.sni = sni;

  const skipCert = url.searchParams.get('insecure') || url.searchParams.get('allowInsecure');
  if (skipCert === '1' || skipCert === 'true') proxy['skip-cert-verify'] = true;

  return proxy;
}

module.exports = { parseHysteria, parseHysteria2 };
