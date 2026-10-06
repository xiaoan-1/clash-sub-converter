const { resolveUserAgent, FALLBACK_UA } = require('./user-agents');
const { ruleManager, ALWAYS_ON_RULE_ID } = require('./rule-manager');
const logger = require('./logger');

const log = logger.create('fetch');

/** 默认 UA（未做任何配置时使用） */
const DEFAULT_FETCH_UA = FALLBACK_UA;

/** 拉取订阅的超时时间。超时与其它失败要分开报，排查方向完全不同 */
const SUBSCRIBE_TIMEOUT_MS = 15000;

/** 失败时预览响应正文的上限，超过就不读了，避免把大文件拉进内存 */
const MAX_PREVIEW_SOURCE_BYTES = 1024 * 1024;

/**
 * Base64 解码
 */
function base64Decode(str) {
  // 处理 URL 安全的 Base64
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  // 补齐 padding
  const padding = str.length % 4;
  if (padding) str += '='.repeat(4 - padding);
  return Buffer.from(str, 'base64').toString('utf-8');
}

/**
 * 安全的 JSON 解析
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * 读取订阅源响应头。
 *
 * 部分机场为了绕过 CDN / 对象存储的限制，会给头加前缀
 * （如 `x-amz-meta-subscription-userinfo`），因此除了精确匹配
 * 还要兼容 `*-<name>` 形式的变体。
 */
function readSubHeader(headers, name) {
  if (!headers) return '';
  const exact = headers.get(name);
  if (exact) return exact;
  const suffix = '-' + name;
  for (const [key, value] of headers) {
    if (key.toLowerCase().endsWith(suffix)) return value;
  }
  return '';
}

/**
 * 解析 subscription-userinfo 响应头。
 *
 * 机场把订阅的流量与到期信息放在这个头里，形如：
 *   upload=1234; download=5678; total=107374182400; expire=1735660800
 * 缺失的字段不输出；无法解析时返回 null。
 *
 * @returns {{upload?:number,download?:number,total?:number,expire?:number}|null}
 */
function parseUserInfo(value) {
  if (!value) return null;
  const info = {};
  for (const part of String(value).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    if (!['upload', 'download', 'total', 'expire'].includes(key)) continue;
    const num = Number(part.slice(idx + 1).trim());
    if (!Number.isFinite(num) || num < 0) continue;
    info[key] = Math.floor(num);
  }
  return Object.keys(info).length ? info : null;
}

/**
 * 合并多个订阅的流量信息（`url` 用 `|` 合并多份订阅时使用）。
 *
 * upload / download / total 累加；expire 取最早的非 0 到期时间
 * （最早到期的最紧要）。单份订阅时等同于原值透传。
 */
function mergeUserInfo(list) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return null;

  const merged = {};
  for (const key of ['upload', 'download', 'total']) {
    if (items.some(i => typeof i[key] === 'number')) {
      merged[key] = items.reduce(
        (sum, i) => sum + (typeof i[key] === 'number' ? i[key] : 0), 0
      );
    }
  }

  const expires = items
    .map(i => i.expire)
    .filter(v => typeof v === 'number' && v > 0);
  if (expires.length) merged.expire = Math.min(...expires);

  return Object.keys(merged).length ? merged : null;
}

/** 把流量信息序列化回 subscription-userinfo 的格式 */
function formatUserInfo(info) {
  if (!info) return '';
  return ['upload', 'download', 'total', 'expire']
    .filter(k => typeof info[k] === 'number')
    .map(k => `${k}=${info[k]}`)
    .join('; ');
}

/** 校验机场官网地址，仅允许 http(s)，防止把任意值透传给客户端 */
function sanitizeHomeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** 解析 profile-update-interval（客户端自动更新间隔，单位小时），限定 1~720 */
function parseUpdateInterval(value) {
  const num = Number(String(value || '').trim());
  if (!Number.isFinite(num) || num <= 0) return '';
  return String(Math.min(Math.floor(num), 720));
}

/**
 * 从 Content-Disposition 取出订阅文件名。
 *
 * Clash Verge 用它作为订阅（profile）的名称，缺失时客户端只能从 URL 猜，
 * 结果往往是 `sub` 这类无意义的名字。
 */
function parseFileName(value) {
  if (!value) return '';
  const matched =
    /filename\*=(?:UTF-8'')?([^;]+)/i.exec(value) ||
    /filename="?([^";]+)"?/i.exec(value);
  if (!matched) return '';

  let name = matched[1].trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    // 编码异常时保留原值
  }
  // 去掉路径分隔符 / 引号 / 控制字符，避免头部注入与路径穿越
  return name.replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 100);
}

/** 组装 Content-Disposition，非 ASCII 文件名用 RFC 5987 编码 */
function buildContentDisposition(fileName) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '');
  if (ascii && ascii === fileName) {
    return `attachment; filename="${ascii}"`;
  }
  const utf8 = encodeURIComponent(fileName).replace(
    /['()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${ascii || 'subscription.yaml'}"; filename*=UTF-8''${utf8}`;
}

/**
 * 判断一个异常是否由超时触发。
 *
 * AbortSignal.timeout 抛出的异常在 err 与 err.cause 上表现不一致，
 * 这里顺着 cause 链扫一遍，两者都认。
 */
function isTimeoutError(err) {
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    const name = String(e.name || '');
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    if (String(e.code || '') === 'UND_ERR_ABORTED') return true;
  }
  return false;
}

/**
 * 把一个失败的 HTTP 响应拆成可落盘的诊断字段。
 *
 * 重点是 `body`：机场在 token 失效 / 订阅过期 / 限流时，通常会在正文里
 * 直接写明原因（`订阅已过期` / `token is invalid` / `请求过于频繁`），
 * 这比状态码本身有用得多。正文统一过 preview() 脱敏 + 截断。
 */
async function describeHttpFailure(response) {
  const headers = response.headers;
  const out = {
    'content-type': headers.get('content-type') || '-',
    reason: `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`,
    hint: logger.httpHint(response.status),
    // 以下头部用于判断「是谁返回的这个错误」：CDN 拦截或机场自己的错误页
    server: headers.get('server') || undefined,
    'cf-ray': headers.get('cf-ray') || undefined,
    via: headers.get('via') || undefined,
    'www-authenticate': headers.get('www-authenticate') || undefined,
    'retry-after': headers.get('retry-after') || undefined,
    location: headers.get('location') || undefined,
  };

  const declared = Number(headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PREVIEW_SOURCE_BYTES) {
    return { ...out, body: `(响应体 ${logger.formatBytes(declared)}，过大未读取)` };
  }

  try {
    const text = await response.text();
    out['body-bytes'] = logger.formatBytes(Buffer.byteLength(text, 'utf-8'));
    out.body = logger.preview(text, 200) || '(空)';
  } catch (err) {
    out.body = `(读取响应体失败：${err.message})`;
  }
  return out;
}

/**
 * 请求订阅源，返回正文与元信息响应头。
 *
 * UA 可配置：机场会校验拉取订阅的客户端标识，若与你的实际客户端不一致，
 * 可能被判定为「非本人操作 / 订阅地址泄漏」而作废订阅地址。
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {string} [options.userAgent] - 直接指定 UA（优先级最高）
 * @param {string} [options.uaSource]  - 这个 UA 是哪来的（仅用于日志）
 * @param {Object} [options.fetchCfg]  - 配置中的 fetch 段 { userAgent, customUserAgent }
 * @param {string} [options.callerUA]  - 调用方请求头里的 UA（供 auto 模式透传）
 * @returns {Promise<{text:string,userInfo:Object|null,homeUrl:string,updateInterval:string,fileName:string}>}
 */
async function requestSubscription(url, options = {}) {
  let ua = options.userAgent;
  let uaSource = options.uaSource;
  if (!ua) {
    // 调用方未预先算 UA 时的兜底，顺带取回「这个 UA 是哪来的」供日志使用
    const resolved = resolveUserAgent(options.fetchCfg || {}, options.callerUA || '');
    ua = resolved.ua;
    uaSource = resolved.source;
  }
  ua = ua || DEFAULT_FETCH_UA;
  uaSource = uaSource || '未标注';

  const safe = logger.safeUrl(url);
  const host = logger.hostOf(url);
  const t = logger.timer();

  // 「用什么去订阅的」：UA 是机场风控的第一道门槛，UV 报 403 时先看这行
  log.debug('发起订阅请求', {
    method: 'GET',
    url: safe,
    host,
    ua,
    'ua-source': uaSource,
    accept: '*/*',
    timeout: logger.formatMs(SUBSCRIBE_TIMEOUT_MS),
    redirect: 'follow',
  });

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept': '*/*' },
      signal: AbortSignal.timeout(SUBSCRIBE_TIMEOUT_MS)
    });
  } catch (err) {
    // 超时 / DNS / TLS / 连接被拒都在这里。区分超时与其他，排查方向完全不同
    const timeout = isTimeoutError(err);
    const d = logger.describeError(err);
    const hint = timeout
      ? '只有这一个订阅超时 → 多半是机场侧问题；所有订阅都超时 → 检查本机网络 / DNS / 代理。'
      : '连接阶段就失败，说明还没到机场的鉴权环节：先确认订阅域名能 ping 通 / 能解析。';
    log.warn('拉取订阅失败：请求未能完成', {
      url: safe,
      host,
      ua,
      'ua-source': uaSource,
      dur: t.text(),
      'fail-stage': timeout ? 'timeout' : 'connect',
      reason: timeout ? `超时（${logger.formatMs(SUBSCRIBE_TIMEOUT_MS)} 内未拿到响应）` : d.reason,
      'net-code': d['net-code'],
      'net-cause': d['net-cause'],
      'net-detail': d['net-detail'],
      'net-hint': d['net-hint'] || (timeout ? '对端在超时时间内未响应：机场侧慢或被网络阻断' : undefined),
      hint,
    });
    // 把翻译结果挂到异常上，供上层（/sub、/api/convert）汇总时复用：
    // Node fetch 的原始错误码在 err.cause 里，上层直接读 err.code 只会拿到空值
    err.netCode = d['net-code'];
    err.hint = err.hint || hint;
    err.stage = timeout ? 'timeout' : 'connect';
    // 上层汇总用这句，而不是 undici 那句英文的 aborted due to timeout
    err.failReason = timeout
      ? `超时（${logger.formatMs(SUBSCRIBE_TIMEOUT_MS)} 内未拿到响应）`
      : err.message;
    throw err;
  }

  // HTTP 层失败：带上状态行、关键响应头与正文摘要。
  // 机场的「token 失效 / 订阅过期 / 请求过于频繁」通常直接写在正文里。
  if (!response.ok) {
    const meta = await describeHttpFailure(response);
    log.warn('拉取订阅失败：服务端返回错误状态码', {
      url: safe,
      host,
      ua,
      'ua-source': uaSource,
      dur: t.text(),
      'fail-stage': 'http',
      status: response.status,
      'status-text': response.statusText || '-',
      server: meta.server,
      'cf-ray': meta['cf-ray'],
      via: meta.via,
      'www-authenticate': meta['www-authenticate'],
      'retry-after': meta['retry-after'],
      location: meta.location,
      'content-type': meta['content-type'],
      'body-bytes': meta['body-bytes'],
      'response-body': meta.body,
      reason: meta.reason,
      hint: meta.hint,
    });

    // 把诊断信息挂到异常上，供上层（/sub、/api/convert）汇总时复用
    const e = new Error(`HTTP ${response.status}`);
    e.status = response.status;
    e.statusText = response.statusText || '';
    e.responseBody = meta.body;
    e.hint = meta.hint;
    e.stage = 'http';
    e.failReason = meta.reason;
    throw e;
  }

  const headers = response.headers;
  const text = await response.text();

  const userInfo = parseUserInfo(readSubHeader(headers, 'subscription-userinfo'));
  const homeUrl = sanitizeHomeUrl(readSubHeader(headers, 'profile-web-page-url'));
  const updateInterval = parseUpdateInterval(readSubHeader(headers, 'profile-update-interval'));
  const fileName = parseFileName(readSubHeader(headers, 'content-disposition'));

  log.info('拉取订阅成功', {
    url: safe,
    host,
    ua,
    'ua-source': uaSource,
    dur: t.text(),
    status: response.status,
    'content-type': headers.get('content-type') || '-',
    bytes: logger.formatBytes(Buffer.byteLength(text, 'utf-8')),
    // age>0 表示这次命中了 CDN 缓存，拿到的是旧订阅，可解释「订阅没更新」
    'cdn-cache': headers.get('cf-cache-status') || headers.get('x-cache') || undefined,
    age: headers.get('age') || undefined,
  });

  // 机场元信息逐项记录：客户端「订阅详情」空白时，靠这几行判断是机场没下发还是本地没转发
  log.debug('订阅元信息', {
    url: safe,
    userinfo: userInfo ? formatUserInfo(userInfo) : '(无)',
    homeUrl: homeUrl || '(无)',
    interval: updateInterval || '(无)',
    fileName: fileName || '(无)',
  });

  return { text, userInfo, homeUrl, updateInterval, fileName };
}

/** 只需订阅正文时的便捷包装 */
async function fetchSubscription(url, options = {}) {
  return (await requestSubscription(url, options)).text;
}

/**
 * 把订阅源下发的元信息响应头转发给客户端。
 *
 * Clash / Clash Verge / ClashX 等客户端靠这些头展示订阅流量、到期时间、
 * 官网入口与自动更新间隔。转换器若只转发 YAML 正文，这些信息会全部丢失，
 * 客户端面板上的订阅详情就是空白。
 *
 * @param {import('express').Response} res
 * @param {Array} metas - requestSubscription 的返回值列表
 */
function applySubscriptionHeaders(res, metas) {
  const list = (metas || []).filter(Boolean);
  if (!list.length) {
    log.debug('无需转发订阅信息：没有成功拉取到的订阅元信息');
    return;
  }

  const userInfo = mergeUserInfo(list.map(m => m.userInfo));
  if (userInfo) res.setHeader('subscription-userinfo', formatUserInfo(userInfo));

  const homeUrl = list.map(m => m.homeUrl).find(Boolean);
  if (homeUrl) res.setHeader('profile-web-page-url', homeUrl);

  const interval = list.map(m => m.updateInterval).find(Boolean);
  if (interval) res.setHeader('profile-update-interval', interval);

  const fileName = list.map(m => m.fileName).find(Boolean);
  if (fileName) {
    try {
      res.setHeader('Content-Disposition', buildContentDisposition(fileName));
    } catch {
      // 文件名含响应头不支持的字符时跳过，不影响正文
    }
  }

  log.debug('订阅信息转发结果', {
    sources: list.length,
    userinfo: userInfo ? formatUserInfo(userInfo) : '(机场未下发)',
    homeUrl: homeUrl || '(无)',
    interval: interval || '(无)',
    fileName: fileName || '(无)',
  });
}

/**
 * 规则组别名映射（OpenClash include/exclude 匹配用）
 *
 * 键 = config/rules/*.json 里的规则 id；值 = 额外的可匹配写法（中英文）。
 * 键之外的 id 无需登记，patternMatchGroup 会退回用 id 本身匹配。
 */
const RULE_GROUP_ALIASES = {
  telegram:         ['telegram', 'tg'],
  openai:           ['openai', 'chatgpt', 'gpt'],
  claude:           ['claude', 'anthropic'],
  gemini:           ['gemini', 'bard', 'google ai', 'deepmind'],
  youtube:          ['youtube', 'ytb'],
  netflix:          ['netflix', 'nf'],
  disney:           ['disney', 'disneyplus'],
  dazn:             ['dazn'],
  bahamut:          ['bahamut', '巴哈姆特'],
  bilibili:         ['bilibili', 'bili', '哔哩哔哩'],
  github:           ['github', 'gh'],
  mihoyo:           ['mihoyo', 'hoyoverse', '米哈游'],
  apple:            ['apple', '苹果', 'icloud', 'appstore'],
  microsoft:        ['microsoft', '微软', 'onedrive', 'bing'],
  pixiv:            ['pixiv', 'pix'],
  'steam-download': ['steam-download', 'steam下载', 'steam下载/联机', 'steam联机'],
  'steam-store':    ['steam-store', 'steam商店', 'steam商店/社区', 'steam社区'],
};

/**
 * 取所有可被 include/exclude 控制的规则组 id。
 * ALWAYS_ON_RULE_ID 不是可选分组（其 target 为 DIRECT）且始终启用，因此排除。
 * 直接从规则目录推导，新增规则文件无需再同步别名表。
 * user-config.js 也用它来判断某规则是否属于可选分组（补全前端分组清单）。
 */
function ruleGroupKeys() {
  return ruleManager.getAll()
    .map(r => r.id)
    .filter(id => id !== ALWAYS_ON_RULE_ID);
}

/**
 * 字面量退化匹配时，允许「别名包含该片段」的最短片段长度。
 * 切词后可能留下单字符残片（例如畸形串 netfli|x 里的 x），
 * 限制长度可避免它命中 pixiv 这类含该字符的别名。
 */
const MIN_FRAGMENT_LEN = 3;

/**
 * 正则模式匹配规则组
 *
 * include/exclude 由 OpenClash 透传，绝大多数是合法正则，走 try 分支。
 * 少数用户会填出无法编译的串，此时退化为字面量猜测。
 */
function patternMatchGroup(pattern, groupKey) {
  if (!pattern) return false;
  const clean = pattern.replace(/^\(\?i\)/, '');
  // 自身 id 始终作为候选：别名表若漏写自身 id，该组会静默失效（本次修过的同类 bug）
  const candidates = [groupKey, ...(RULE_GROUP_ALIASES[groupKey] || [])];
  try {
    const re = new RegExp(clean, 'i');
    return candidates.some(a => re.test(a));
  } catch {
    // 非法正则：退化为字面量匹配，但必须先按分隔符切词，不能对整串做子串匹配。
    // 原实现是双向子串（别名含原文 || 原文含别名），反向那一支没有词边界，
    // 两三个字母的别名会命中毫不相干的词：
    //   confirm[ → nf → netflix      high[ / weight[ → gh → github
    //   pixel[   → pix → pixiv
    // 于是 exclude 会静默关掉用户根本没提过的整组规则；同时反向还会漏掉
    // (?i)steam[ 这种「别名含原文」本应命中的情况（原文尾部粘着 [ 导致整串匹配失败）。
    // 切词后：整词相等一律认；「别名包含该片段」限制在 >= MIN_FRAGMENT_LEN。
    const tokens = clean.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    return tokens.some(t => candidates.some(a => {
      const alias = a.toLowerCase();
      return alias === t || (t.length >= MIN_FRAGMENT_LEN && alias.includes(t));
    }));
  }
}

/**
 * 解析 OpenClash 发送的 include/exclude 正则，映射到内部规则组
 */
function parseRuleOptions(include, exclude) {
  const ruleKeys = ruleGroupKeys();
  const ruleOptions = {};

  // 默认全部启用
  for (const key of ruleKeys) ruleOptions[key] = true;

  // include: 先全部禁用，只启用匹配的
  if (include) {
    for (const key of ruleKeys) ruleOptions[key] = false;
    for (const key of ruleKeys) {
      if (patternMatchGroup(include, key)) ruleOptions[key] = true;
    }
  }

  // exclude: 排除匹配的
  if (exclude) {
    for (const key of ruleKeys) {
      if (patternMatchGroup(exclude, key)) ruleOptions[key] = false;
    }
  }

  return ruleOptions;
}

module.exports = {
  base64Decode,
  safeJsonParse,
  fetchSubscription,
  requestSubscription,
  applySubscriptionHeaders,
  parseUserInfo,
  mergeUserInfo,
  formatUserInfo,
  DEFAULT_FETCH_UA,
  RULE_GROUP_ALIASES,
  patternMatchGroup,
  parseRuleOptions,
  ruleGroupKeys
};
