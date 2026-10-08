/**
 * Shadowsocks / ShadowsocksR 解析（同族共享 userinfo 解析）
 */
const { base64Decode } = require('../utils');
const { safeDecodeURIComponent, parseSsUserInfo } = require('./utils');

/**
 * 解析 SS 链接
 * 格式: ss://base64(method:password)@server:port#name
 * 或:   ss://base64(method:password@server:port)#name
 */
function parseShadowsocks(link) {
  const content = link.replace('ss://', '');
  const nameIdx = content.indexOf('#');
  let name = '';
  let body = content;

  if (nameIdx !== -1) {
    name = safeDecodeURIComponent(content.substring(nameIdx + 1));
    body = content.substring(0, nameIdx);
  }

  let creds, server, port;

  if (body.includes('@')) {
    // SIP002 格式: ss://userinfo@server:port
    // 按第一个 @ 切分：host 部分不含 @，而密码里可能有
    const atIdx = body.indexOf('@');
    creds = parseSsUserInfo(body.substring(0, atIdx));
    const hostinfo = body.substring(atIdx + 1);
    const lastColon = hostinfo.lastIndexOf(':');
    server = hostinfo.substring(0, lastColon);
    port = parseInt(hostinfo.substring(lastColon + 1));
  } else {
    // 旧格式: ss://base64(method:password@server:port)
    const decoded = base64Decode(body);
    const atIdx = decoded.indexOf('@');
    if (atIdx === -1) return null;
    creds = parseSsUserInfo(decoded.substring(0, atIdx));
    const hostPart = decoded.substring(atIdx + 1);
    const lastColon = hostPart.lastIndexOf(':');
    server = hostPart.substring(0, lastColon);
    port = parseInt(hostPart.substring(lastColon + 1));
  }

  if (!creds || !creds.method || !server || !port) return null;

  return {
    name: name || `${server}:${port}`,
    type: 'ss',
    server,
    port,
    password: creds.password,
    cipher: creds.method,
    udp: true
  };
}

/**
 * 解析 SSR 链接
 * 格式: ssr://base64(server:port:protocol:method:obfs:base64(password)/?params)
 */
function parseShadowsocksR(link) {
  const decoded = base64Decode(link.replace('ssr://', ''));
  const parts = decoded.split('/?');
  const mainPart = parts[0];
  const params = parts[1] || '';

  const [server, port, protocol, method, obfs, passwordB64] = mainPart.split(':');
  const password = base64Decode(passwordB64);

  // 解析参数
  const paramObj = {};
  if (params) {
    params.split('&').forEach(p => {
      const [k, v] = p.split('=');
      if (v) paramObj[k] = base64Decode(v);
    });
  }

  const name = paramObj.remarks || `${server}:${port}`;

  return {
    name,
    type: 'ssr',
    server,
    port: parseInt(port),
    password,
    cipher: method || 'aes-256-cfb',
    protocol,
    'protocol-param': paramObj.protoparam || '',
    obfs,
    'obfs-param': paramObj.obfsparam || '',
    udp: true
  };
}

module.exports = { parseShadowsocks, parseShadowsocksR };
