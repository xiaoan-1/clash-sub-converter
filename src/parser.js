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
 * 解析多份订阅内容并合并为一个节点数组。
 *
 * 多订阅必须「先分别解析、再合并」：把多份 Clash YAML 直接拼接会产生重复根键，
 * yaml.load 会直接抛错，最终表现为一个节点都拿不到。
 * 另外 mihomo 不允许代理重名，因此同名节点只保留最先出现的那一个。
 *
 * @param {string[]} sources 每份订阅的原始文本
 * @returns {{ proxies: Array, dropped: number }} dropped 为因重名被丢弃的节点数
 */
function parseSubscriptionList(sources = []) {
  const proxies = [];
  const seenNames = new Set();
  let dropped = 0;

  for (const text of sources) {
    if (!text || !String(text).trim()) continue;

    for (const proxy of parseSubscription(text)) {
      const name = String(proxy.name || '').trim();
      if (!name) {
        proxies.push(proxy);
        continue;
      }
      if (seenNames.has(name)) {
        dropped++;
        continue;
      }
      seenNames.add(name);
      proxies.push(proxy);
    }
  }

  return { proxies, dropped };
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
 * decodeURIComponent 的安全包装。
 * 用户给的名称里常有裸 `%`（如「100% 稳定」），decodeURIComponent 会抛 URIError；
 * 那样会让整条节点被丢弃，而这里完全可以退回原字符串。
 */
function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

/**
 * 解析 SS 的 userinfo，得到 { method, password }。
 *
 * SIP002 规定 userinfo 既可以是 URL-safe base64，也可以是 URL 编码的明文，两种都得支持：
 *   ss://<base64(aes-256-gcm:password)>@host:port
 *   ss://aes-256-gcm:password@host:port
 * 明文必然含冒号，而 base64 字符集（A-Za-z0-9+/-_）不含冒号，可据此区分。
 *
 * 密码允许含冒号（如 `pa:ss:word`），所以只能按「第一个冒号」切分 ——
 * 用 split(':') 只取前两段会把密码截断成 `pa`，进而连不上节点。
 * 加密方式名称本身不含冒号（aes-256-gcm、chacha20-ietf-poly1305 …），该前提由 SS 协议保证。
 *
 * @returns {{method:string, password:string}|null} 辨认不出「加密方式:密码」时返回 null
 */
function parseSsUserInfo(userinfo) {
  const decoded = userinfo.includes(':') ? safeDecodeURIComponent(userinfo) : base64Decode(userinfo);
  const sep = decoded.indexOf(':');
  // 既非明文也非合法 base64 时拿不到冒号：与其产出一个密码/加密方式错乱的节点，不如丢弃
  if (sep === -1) return null;
  return {
    method: decoded.substring(0, sep).trim(),
    password: decoded.substring(sep + 1)
  };
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
 *
 * 注意 mihomo 的 VLESS 与 VMess 字段并不通用：
 *   - 没有 alterId / cipher，带上去会被内核判为不支持的字段
 *   - SNI 用 servername，不是 sni
 *   - XTLS 流控用 flow
 */
function parseVless(link) {
  const url = new URL(link);
  const name = decodeURIComponent(url.hash.substring(1)) || `${url.hostname}:${url.port}`;

  const proxy = {
    name,
    type: 'vless',
    server: url.hostname,
    port: parseInt(url.port),
    uuid: decodeURIComponent(url.username),
    udp: true
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
  if (alpn) proxy.alpn = alpn.split(',').map(s => s.trim()).filter(Boolean);

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
      headers: { Host: url.searchParams.get('host') || '' }
    };
  } else if (transport === 'grpc') {
    proxy.network = 'grpc';
    proxy['grpc-opts'] = {
      'grpc-service-name': url.searchParams.get('serviceName') || ''
    };
  } else if (transport === 'h2') {
    proxy.network = 'h2';
    proxy['h2-opts'] = {
      host: [url.searchParams.get('host') || ''],
      path: url.searchParams.get('path') || '/'
    };
  } else if (transport) {
    proxy.network = transport;
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
  parseSubscriptionList,
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
