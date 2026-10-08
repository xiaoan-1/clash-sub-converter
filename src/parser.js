const yaml = require('js-yaml');
const { base64Decode } = require('./utils/encoding');
const logger = require('./logger');

const log = logger.create('parser');

// ===================== 协议解析器注册 =====================

/**
 * 各协议解析器按分类文件注册。
 * 每个注册项: { prefixes: [URI 前缀...], types: [Clash 类型...], parse: 函数 }
 * 新增协议只需在此登记一行，无需改动 parseSubscription 主流程。
 */
const PROTOCOL_PARSERS = [
  { prefixes: ['vmess://'],      types: ['vmess'],         parse: require('./parser/vmess').parseVmess },
  { prefixes: ['ss://'],         types: ['ss', 'shadowsocks'], parse: require('./parser/ss').parseShadowsocks },
  { prefixes: ['ssr://'],        types: ['ssr', 'shadowsocksr'], parse: require('./parser/ss').parseShadowsocksR },
  { prefixes: ['trojan://'],     types: ['trojan'],        parse: require('./parser/trojan').parseTrojan },
  { prefixes: ['vless://'],      types: ['vless'],         parse: require('./parser/vless').parseVless },
  { prefixes: ['hysteria2://', 'hy2://'], types: ['hysteria2'], parse: require('./parser/hysteria').parseHysteria2 },
  { prefixes: ['hysteria://'],   types: ['hysteria'],      parse: require('./parser/hysteria').parseHysteria },
  { prefixes: ['anytls://'],     types: ['anytls'],        parse: require('./parser/anytls').parseAnyTLS },
  { prefixes: ['tuic://'],       types: ['tuic'],          parse: require('./parser/tuic').parseTUIC },
  { prefixes: ['snell://'],      types: ['snell'],         parse: require('./parser/snell').parseSnell },
  { prefixes: ['socks5://', 'socks://'], types: ['socks5'], parse: require('./parser/socks-http').parseSocks },
  { prefixes: ['http://', 'https://'], types: ['http'],    parse: require('./parser/socks-http').parseHttp },
  { prefixes: ['wireguard://', 'wg://'], types: ['wireguard'], parse: require('./parser/wireguard').parseWireGuard },
  { prefixes: ['shadowquic://'], types: ['shadowquic'],    parse: require('./parser/shadowquic').parseShadowQUIC },
];

// 支持的代理类型（Clash YAML 输入的白名单）
const SUPPORTED_TYPES = new Set(PROTOCOL_PARSERS.flatMap(p => p.types));
// 支持解码的 URI scheme 前缀
const URI_SCHEME_PREFIXES = PROTOCOL_PARSERS.flatMap(p => p.prefixes);

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

  const proxies = doc.proxies
    .filter(p => p && p.name && SUPPORTED_TYPES.has(normalizeType(p.type)))
    .map(p => {
      const proxy = { ...p, type: normalizeType(p.type) };
      // clash yaml 里的端口可能是字符串
      if (proxy.port) proxy.port = parseInt(proxy.port);
      if (proxy.alterId !== undefined) proxy.alterId = parseInt(proxy.alterId);
      if (proxy.udp === undefined) proxy.udp = true;
      return proxy;
    });

  // YAML 里声明了但类型不受支持 / 缺 name 的节点，会在上面被静默过滤掉。
  // 这是「订阅里明明有 200 个节点，转换后只剩 150」最常见的原因，必须留下痕迹。
  const declared = doc.proxies.length;
  if (proxies.length !== declared) {
    const skipped = doc.proxies
      .filter(p => !p || !p.name || !SUPPORTED_TYPES.has(normalizeType(p.type)))
      .slice(0, 10)
      .map(p => `${p && p.name ? p.name : '(无name)'}<${p ? p.type || '?' : '?'}>`);
    log.warn('Clash YAML 中有节点未被采用', {
      declared,
      kept: proxies.length,
      dropped: declared - proxies.length,
      sample: skipped,
    });
  }

  return proxies;
}

/**
 * 统一代理类型名称（shadowsocks → ss 等）
 */
function normalizeType(type) {
  if (!type) return type;
  const map = { shadowsocks: 'ss', shadowsocksr: 'ssr' };
  return map[type.toLowerCase()] || type.toLowerCase();
}

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

/**
 * 解析订阅内容，返回统一的代理节点数组
 * 支持格式:
 *   - URI 列表: 各协议 URI（见 PROTOCOL_PARSERS 注册表）
 *   - Clash YAML: 包含 proxies: 数组的 YAML 配置
 */
function parseSubscription(content) {
  // 尝试 Base64 解码（仅当解码结果可解析时才采用，见 decodeSubscriptionContent）
  const raw = (content || '').trim();
  const decoded = decodeSubscriptionContent(content);
  const wasBase64 = decoded !== raw;

  // 优先尝试 Clash YAML 格式（包含 proxies 数组）
  const proxiesFromYaml = tryParseClashYaml(decoded);
  if (proxiesFromYaml) {
    log.debug('按 Clash YAML 解析', { bytes: raw.length, base64: wasBase64, proxies: proxiesFromYaml.length });
    return proxiesFromYaml;
  }

  // 回退到 URI scheme 解析（按注册表前缀匹配）
  const lines = decoded.split('\n').map(l => l.trim()).filter(l => l && l.includes('://'));
  const proxies = [];

  // 被丢弃的行按「原因 + 样例」汇总，避免一个坏行刷一整屏日志，
  // 同时又不至于像以前那样静默丢弃（不认识的 scheme 完全不报）。
  const unknownSchemes = new Map(); // scheme -> 出现次数
  const failures = [];             // 解析抛错的行

  for (const line of lines) {
    try {
      // 查找匹配的前缀处理器
      const handler = PROTOCOL_PARSERS.find(p => p.prefixes.some(prefix => line.startsWith(prefix)));

      if (!handler) {
        // 不支持的 scheme
        const scheme = (line.match(/^([a-z0-9+.-]+):\/\//i) || [, '(无 scheme)'])[1].toLowerCase();
        unknownSchemes.set(scheme, (unknownSchemes.get(scheme) || 0) + 1);
        continue;
      }

      const proxy = handler.parse(line);
      if (!proxy) {
        const scheme = (line.match(/^([a-z0-9+.-]+):\/\//i) || [, '(无 scheme)'])[1].toLowerCase();
        unknownSchemes.set(`${scheme}(解析为空)`, (unknownSchemes.get(`${scheme}(解析为空)`) || 0) + 1);
        continue;
      }
      proxies.push(proxy);
    } catch (err) {
      // 只记录 scheme + 错误，绝不打印完整 URI（内含密码 / UUID）
      const scheme = (line.match(/^([a-z0-9+.-]+):\/\//i) || [, '(无 scheme)'])[1].toLowerCase();
      failures.push(`${scheme}: ${err.message}`);
    }
  }

  if (unknownSchemes.size) {
    log.warn('部分行未识别，已跳过', {
      lines: lines.length,
      detail: Object.fromEntries(unknownSchemes),
    });
  }
  if (failures.length) {
    log.warn('部分节点解析失败，已跳过', {
      failed: failures.length,
      sample: failures.slice(0, 10),
    });
  }

  log.debug('按 URI 列表解析', {
    bytes: raw.length,
    base64: wasBase64,
    lines: lines.length,
    proxies: proxies.length,
    types: logger.countBy(proxies, p => p.type),
  });

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
  const droppedNames = [];

  log.debug('开始解析订阅列表', { sources: sources.length });

  sources.forEach((text, index) => {
    const label = `源 ${index + 1}/${sources.length}`;

    if (!text || !String(text).trim()) {
      log.warn(`${label} 内容为空，跳过`);
      return;
    }

    // 判定格式：用于排查「机场给的是 YAML 还是 base64 的 URI 列表」
    const trimmed = String(text).trim();
    const decoded = decodeSubscriptionContent(trimmed);
    const base64 = decoded !== trimmed;
    let format = 'unknown';
    if (isClashYamlText(decoded)) format = 'clash-yaml';
    else if (isUriListText(decoded)) format = 'uri-list';

    const list = parseSubscription(text);
    let ownDropped = 0;

    for (const proxy of list) {
      const name = String(proxy.name || '').trim();
      if (!name) {
        proxies.push(proxy);
        continue;
      }
      if (seenNames.has(name)) {
        dropped++;
        ownDropped++;
        if (droppedNames.length < 10) droppedNames.push(name);
        continue;
      }
      seenNames.add(name);
      proxies.push(proxy);
    }

    log.info(`${label} 解析完成`, {
      format,
      base64,
      bytes: logger.formatBytes(Buffer.byteLength(text, 'utf-8')),
      nodes: list.length,
      types: logger.countBy(list, p => p.type),
      dupDropped: ownDropped || undefined,
    });

    if (!list.length) {
      log.warn(`${label} 未解析出任何节点`, { format, base64 });
    }
  });

  log.info('合并完成', {
    sources: sources.length,
    nodes: proxies.length,
    dupDropped: dropped || undefined,
    dupSample: droppedNames.length ? droppedNames : undefined,
  });

  return { proxies, dropped };
}

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

module.exports = {
  parseSubscription,
  parseSubscriptionList,
  extractClashDns
};
