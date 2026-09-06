const yaml = require('js-yaml');
const { base64Decode, safeJsonParse } = require('./utils');

// 支持的代理类型
const SUPPORTED_TYPES = new Set(['vmess', 'ss', 'ssr', 'trojan', 'vless', 'hysteria2', 'shadowsocks', 'shadowsocksr']);

/**
 * 尝试将内容解析为包含 proxies 数组的 Clash YAML 文档
 * @returns {Object|null} 完整 YAML 文档，或 null 表示不是 Clash YAML
 */
function tryLoadClashDoc(content) {
  try {
    const doc = yaml.load(content);
    if (!doc || !Array.isArray(doc.proxies)) return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * 尝试解析 Clash YAML 格式
 * @returns {Array|null} 代理数组，或 null 表示不是 YAML 格式
 */
function tryParseClashYaml(content) {
  const doc = tryLoadClashDoc(content);
  if (!doc) return null;

  return doc.proxies
    .filter(p => p && p.name && SUPPORTED_TYPES.has(normalizeType(p.type)))
    .map(p => {
      const proxy = { ...p, type: normalizeType(p.type) };
      // clash yaml 里的端口可能是字符串
      if (proxy.port) proxy.port = parseInt(proxy.port);
      if (proxy.alterId !== undefined) proxy.alterId = parseInt(proxy.alterId);
      if (proxy.udp === undefined) proxy.udp = true;
      return proxy;
    });
}

/**
 * 统一代理类型名称（shadowsocks → ss 等）
 */
// 支持解码的 URI scheme 前缀
const URI_SCHEME_PREFIXES = ['vmess://', 'ss://', 'ssr://', 'trojan://', 'vless://', 'hysteria2://', 'hy2://'];

/**
 * 判断文本是否为可解析的 Clash YAML（含 proxies 数组）
 */
function isClashYamlText(text) {
  try {
    const doc = yaml.load(text);
    return !!doc && typeof doc === 'object' && Array.isArray(doc.proxies);
  } catch {
    return false;
  }
}

/**
 * 判断文本是否为「每行一个 URI」的节点列表
 */
function isUriListText(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(l => URI_SCHEME_PREFIXES.some(p => l.startsWith(p)));
}

/**
 * 订阅内容解码
 * 说明：base64Decode 是宽容解码（对任意字符串都不会抛错），因此不能只靠 try/catch
 * 判断是否为 Base64 —— 必须验证「解码结果真的能被解析」才采用，否则保留原文，
 * 避免把明文 YAML / URI 文本误判为 Base64 导致解析失败。
 * @returns {string} 可用于后续解析的文本
 */
function decodeSubscriptionContent(content) {
  const original = (content || '').trim();
  if (!original) return original;

  const decoded = base64Decode(original);
  if (decoded && decoded !== original && (isClashYamlText(decoded) || isUriListText(decoded))) {
    return decoded;
  }
  return original;
}

function normalizeType(type) {
  if (!type) return type;
  const map = { shadowsocks: 'ss', shadowsocksr: 'ssr' };
  return map[type.toLowerCase()] || type.toLowerCase();
}

/**
 * 解析订阅内容，返回统一的代理节点数组
 * 支持格式:
 *   - URI 列表: ss://, ssr://, vmess://, trojan://, hysteria2://, vless://
 *   - Clash YAML: 包含 proxies: 数组的 YAML 配置
 */
function parseSubscription(content) {
  // 尝试 Base64 解码（仅当解码结果可解析时才采用，见 decodeSubscriptionContent）
  const decoded = decodeSubscriptionContent(content);

  // 优先尝试 Clash YAML 格式（包含 proxies 数组）
  const proxiesFromYaml = tryParseClashYaml(decoded);
  if (proxiesFromYaml) return proxiesFromYaml;

  // 回退到 URI scheme 解析
  const lines = decoded.split('\n').map(l => l.trim()).filter(l => l && l.includes('://'));
  const proxies = [];

  for (const line of lines) {
    try {
      if (line.startsWith('vmess://')) {
        const proxy = parseVmess(line);
        if (proxy) proxies.push(proxy);
      } else if (line.startsWith('ss://')) {
        const proxy = parseShadowsocks(line);
        if (proxy) proxies.push(proxy);
      } else if (line.startsWith('ssr://')) {
        const proxy = parseShadowsocksR(line);
        if (proxy) proxies.push(proxy);
      } else if (line.startsWith('trojan://')) {
        const proxy = parseTrojan(line);
        if (proxy) proxies.push(proxy);
      } else if (line.startsWith('vless://')) {
        const proxy = parseVless(line);
        if (proxy) proxies.push(proxy);
      } else if (line.startsWith('hysteria2://') || line.startsWith('hy2://')) {
        const proxy = parseHysteria2(line);
        if (proxy) proxies.push(proxy);
      }
    } catch (err) {
      console.warn(`[Parser] 跳过无效节点: ${line.substring(0, 50)}... 错误: ${err.message}`);
    }
  }

  return proxies;
}

/**
 * 解析 VMess 链接
 * 格式: vmess://base64({json})
 */
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
    udp: true
  };

  // 网络传输层
  const net = json.net || 'tcp';
  if (net === 'ws') {
    proxy.network = 'ws';
    proxy['ws-opts'] = {
      path: json.path || '/',
      headers: { Host: json.host || '' }
    };
  } else if (net === 'h2') {
    proxy.network = 'h2';
    proxy['h2-opts'] = {
      host: [json.host || ''],
      path: json.path || '/'
    };
  } else if (net === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = {
      'grpc-service-name': json.path || ''
    };
  } else if (net === 'http') {
    proxy.network = 'http';
    proxy['http-opts'] = {
      path: [json.path || '/'],
      method: 'POST',
      headers: {
        Connection: ['keep-alive'],
        Host: [json.host || '']
      }
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
    name = decodeURIComponent(content.substring(nameIdx + 1));
    body = content.substring(0, nameIdx);
  }

  let method, password, server, port;

  if (body.includes('@')) {
    // SIP002 格式: ss://base64(method:password)@server:port
    const [userinfo, hostinfo] = body.split('@');
    const decoded = base64Decode(userinfo);
    [method, password] = decoded.split(':');
    const lastColon = hostinfo.lastIndexOf(':');
    server = hostinfo.substring(0, lastColon);
    port = parseInt(hostinfo.substring(lastColon + 1));
  } else {
    // 旧格式: ss://base64(method:password@server:port)
    const decoded = base64Decode(body);
    const atIdx = decoded.lastIndexOf('@');
    const methodPass = decoded.substring(0, atIdx);
    const hostPart = decoded.substring(atIdx + 1);
    [method, password] = methodPass.split(':');
    const lastColon = hostPart.lastIndexOf(':');
    server = hostPart.substring(0, lastColon);
    port = parseInt(hostPart.substring(lastColon + 1));
  }

  if (!server || !port) return null;

  return {
    name: name || `${server}:${port}`,
    type: 'ss',
    server,
    port,
    password,
    cipher: method || 'aes-256-gcm',
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

/**
 * 解析 Trojan 链接
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
    udp: true
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
      headers: { Host: url.searchParams.get('host') || '' }
    };
  } else if (transport === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = {
      'grpc-service-name': url.searchParams.get('serviceName') || ''
    };
  }

  return proxy;
}

/**
 * 解析 VLESS 链接
 * 格式: vless://uuid@server:port?params#name
 */
function parseVless(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'vmess',  // Clash 中 VLESS 通常通过 vmess 类型代理
    server: url.hostname,
    port: parseInt(url.port),
    uuid: url.username,
    alterId: 0,
    cipher: 'auto',
    udp: true
  };

  const sni = url.searchParams.get('sni');
  if (sni) proxy.sni = sni;

  const security = url.searchParams.get('security');
  if (security === 'tls') {
    proxy.tls = true;
  }

  const transport = url.searchParams.get('type');
  if (transport === 'ws') {
    proxy.network = 'ws';
    proxy['ws-opts'] = {
      path: url.searchParams.get('path') || '/',
      headers: { Host: url.searchParams.get('host') || '' }
    };
  } else if (transport === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = {
      'grpc-service-name': url.searchParams.get('serviceName') || ''
    };
  }

  return proxy;
}

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

module.exports = {
  parseSubscription,
  extractClashDns
};

/**
 * 从订阅内容中提取 Clash YAML 自带的 DNS 配置
 * 转换时透传它，保证转换结果与「直接用订阅链接导入」行为等价。
 * 仅对 Clash YAML 类输入有意义：URI 列表 / Base64 的 URI 列表不含 dns，返回 null。
 * @param {string} content - 原始订阅文本（可能为 Base64 或 Clash YAML）
 * @returns {Object|null} dns 配置对象，或 null
 */
function extractClashDns(content) {
  const decoded = decodeSubscriptionContent(content);
  try {
    const doc = yaml.load(decoded);
    // 独立解析 dns，不要求文档同时含 proxies；且仅接受对象类型的 dns
    if (doc && typeof doc === 'object' && !Array.isArray(doc) &&
        doc.dns && typeof doc.dns === 'object' && !Array.isArray(doc.dns)) {
      return doc.dns;
    }
  } catch {
    // 非 YAML / 多文档拼接等无法解析，返回 null
  }
  return null;
}
