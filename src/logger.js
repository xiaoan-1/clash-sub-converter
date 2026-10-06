/**
 * 统一日志模块
 *
 * 输出到 logs/ 下的文本文件，用于事后排查「订阅为什么少了节点 / 转换为什么报错」：
 *   logs/app.log   —— 全部级别，完整流程轨迹
 *   logs/error.log —— warn / error，只看问题
 *
 * 同时镜像到控制台，因此 `node index.js` 直接跑也能看到实时输出。
 *
 * 为什么不用现成的库（winston / pino）：本项目零运行时依赖，只有 express + js-yaml，
 * 排查用日志不值得为此引入依赖树。这里真正需要的只有「分级 + 写盘 + 轮转」三件事。
 *
 * 安全约定（重要）
 * ----------------
 * 订阅地址普遍把 token 直接写在路径或查询串里，**绝不允许原样落盘**。
 * 所有 URL 必须先过 safeUrl() 再进日志；写日志时不要传 headers 对象。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const APP_LOG = path.join(LOG_DIR, 'app.log');
const ERR_LOG = path.join(LOG_DIR, 'error.log');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const pickLevelName = (raw, fallback) => {
  const name = String(raw || '').trim().toLowerCase();
  return LEVELS[name] !== undefined ? name : fallback;
};

/**
 * 文件记录到 debug（默认全量，排查时才能看到每个阶段），
 * 控制台只到 info，避免直接 node 运行时刷屏。
 * 用 LOG_LEVEL / LOG_CONSOLE_LEVEL 覆盖。
 */
const FILE_LEVEL_NAME = pickLevelName(process.env.LOG_LEVEL, 'debug');
const CONSOLE_LEVEL_NAME = pickLevelName(process.env.LOG_CONSOLE_LEVEL, 'info');
const FILE_LEVEL = LEVELS[FILE_LEVEL_NAME];
const CONSOLE_LEVEL = LEVELS[CONSOLE_LEVEL_NAME];

/** 单个日志文件体积上限，超出后转存为 .1（只保留一份历史） */
const MAX_BYTES = Number(process.env.LOG_MAX_BYTES) || 5 * 1024 * 1024;

/** 单个字段值的最大长度，防止把整份订阅正文写进日志 */
const MAX_VALUE_LEN = 400;

/** 数组最多展示的元素个数 */
const MAX_ARRAY_ITEMS = 20;

/** 响应正文预览的最大长度（订阅失败时用来放机场返回的错误说明） */
const MAX_PREVIEW_LEN = 300;

/** 正文预览超过这个体积就不读了，避免把大文件拉进内存 */
const MAX_PREVIEW_SOURCE_BYTES = 1024 * 1024;

let dirReady = false;
let fileBroken = false;

// ===================== 基础设施 =====================

function ensureDir() {
  if (dirReady) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
    return true;
  } catch (err) {
    if (!fileBroken) {
      fileBroken = true;
      process.stderr.write(`[logger] 无法创建日志目录 ${LOG_DIR}: ${err.message}（后续日志仅输出到控制台）\n`);
    }
    return false;
  }
}

/** 超过上限就把当前文件改名为 .1（先删旧的，Windows 上 rename 不覆盖已存在文件） */
function rotate(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // 文件还不存在
  }
  if (size < MAX_BYTES) return;
  try { fs.rmSync(`${file}.1`, { force: true }); } catch { /* 忽略 */ }
  try { fs.renameSync(file, `${file}.1`); } catch { /* 忽略 */ }
}

function emit(file, line) {
  if (fileBroken) return;
  if (!ensureDir()) return;
  try {
    rotate(file);
    fs.appendFileSync(file, line, 'utf-8');
  } catch (err) {
    fileBroken = true;
    process.stderr.write(`[logger] 写入 ${file} 失败: ${err.message}（后续日志仅输出到控制台）\n`);
  }
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function truncate(s) {
  return s.length > MAX_VALUE_LEN ? `${s.slice(0, MAX_VALUE_LEN)}…(共 ${s.length} 字符)` : s;
}

/** 把任意值格式化成单行、可 grep 的短字符串 */
function fmtValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) {
    const shown = v.slice(0, MAX_ARRAY_ITEMS).map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
    const rest = v.length - shown.length;
    return `[${shown.join(', ')}${rest > 0 ? `, …+${rest}` : ''}](${v.length})`;
  }
  if (typeof v === 'object') {
    try {
      return truncate(JSON.stringify(v));
    } catch {
      return '[不可序列化]';
    }
  }
  // 字符串：折叠换行，避免一条日志占多行
  return truncate(String(v).replace(/\s+/g, ' '));
}

function stackOf(err) {
  if (!err || !err.stack) return undefined;
  // 只保留前几帧，够定位即可
  const lines = String(err.stack).split('\n').slice(0, 6).join(' <- ');
  return truncate(lines.replace(/\s+/g, ' '));
}

// ===================== 错误与安全文本处理 =====================

/** 看起来像凭据的键名（查询串 / JSON / kv 三种形态共用） */
const SECRET_KEYS = 'token|sub|code|key|auth|pwd|passwd|password|sign|secret|access_key';
const RE_SECRET_QUERY = new RegExp(`([?&](?:${SECRET_KEYS})=)[^&#\\s]*`, 'gi');
// 键值形态：兼容 `token=xxx`、`"token":"xxx"`、`'token': 'xxx'`。
// 注意 JSON 里键名的闭合引号在冒号**之前**，所以 `("|')?` 要出现两次；
// 引号（$2/$4）保留，只把值换成 ***，保证 JSON 预览仍是合法片段。
const RE_SECRET_KV = new RegExp(
  `\\b(${SECRET_KEYS})("|')?(\\s*[=:]\\s*)("|')?(?!\\*{3})[^\\s,;"'\\\\}?&#/|]+`,
  'gi'
);

/** 把文本里形如 token=xxx / "password":"xxx" 的凭据值抹成 *** */
function redactSecrets(raw) {
  return String(raw === null || raw === undefined ? '' : raw)
    .replace(RE_SECRET_QUERY, '$1***')
    .replace(RE_SECRET_KV, '$1$2$3$4***');
}

/**
 * 生成一段可安全落盘的响应正文预览。
 *
 * 订阅拉取失败时机场往往会在正文里写明原因（`token 已失效` / `订阅已过期` /
 * `请求过于频繁`），这是排查里信息量最大的一条，必须记下来；
 * 但正文也可能夹带 token，所以统一过一遍 redactSecrets。
 */
function preview(raw, limit = MAX_PREVIEW_LEN) {
  if (raw === null || raw === undefined) return '';
  const text = String(raw);
  if (!text) return '(空)';
  // 压缩 / 二进制内容（gzip 未被 fetch 解开、或对端返回了图片）肉眼不可读
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) return '(二进制内容，已省略)';

  const flat = redactSecrets(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '(空白内容)';
  return truncate(flat.length > limit ? `${flat.slice(0, limit)}…` : flat);
}

/**
 * 网络错误码 → 人话。
 *
 * Node 的 fetch 把所有网络层失败统一报成 `fetch failed`，真正的原因在
 * `err.cause.code` 上。不翻译一遍的话，日志上只有一句「fetch failed」，
 * 完全无法判断是 DNS 问题、证书问题，还是机场风控主动断开。
 */
const NET_HINTS = {
  ENOTFOUND: '域名解析失败：DNS 查不到该主机，检查订阅地址是否写错',
  EAI_AGAIN: 'DNS 临时故障：解析超时，通常是本机 DNS 或网络问题',
  ECONNREFUSED: '连接被拒绝：对端未在该端口监听，或被防火墙拦截',
  ECONNRESET: '连接被重置：对端主动断开，常见于代理 / 机场风控',
  ETIMEDOUT: 'TCP 连接超时：网络不通或对端无响应',
  EPIPE: '连接被对端关闭',
  EHOSTUNREACH: '主机不可达：路由问题',
  ENETUNREACH: '网络不可达：本机没有到该网段的路由',
  CERT_HAS_EXPIRED: 'TLS 证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS 自签名证书：对端证书不被信任',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书链无法验证：缺中间证书，或链路上有 MITM 代理',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS 缺少根证书：系统 CA 不完整',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书域名不匹配：可能被中间人代理',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 握手失败：该端口可能不是 HTTPS',
  UND_ERR_CONNECT_TIMEOUT: '建立连接超时：对端不可达',
  UND_ERR_HEADERS_TIMEOUT: '等待响应头超时：已连上但对端不返回数据',
  UND_ERR_BODY_TIMEOUT: '读取响应正文超时',
  UND_ERR_SOCKET: '连接异常中断',
  UND_ERR_ABORTED: '请求被中止（通常是超时触发）',
};

/**
 * 把一个异常摊平成可直接写进日志的字段。
 *
 * 会顺着 `cause` 链向下找 4 层：Node fetch 的 `fetch failed` 本身没有任何信息，
 * 必须靠 cause 才能看到 ENOTFOUND / ECONNREFUSED / UND_ERR_* 这些真正的错误码。
 */
function describeError(err) {
  if (!err) return {};
  const out = { reason: String(err.message || err) };
  if (err.code) out.code = String(err.code);

  const chain = [];
  const codes = [];
  const details = [];

  for (let cur = err.cause, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    const head = cur.code || (cur.name && cur.name !== 'Error' ? cur.name : '');
    chain.push([head, cur.message].filter(Boolean).join(' ') || String(cur));
    if (cur.code) codes.push(String(cur.code));
    // syscall / 地址等定位信息（不同 Node 版本挂的层级不同，收集第一个命中的）
    if (!details.length && (cur.syscall || cur.hostname || cur.address)) {
      const parts = [];
      if (cur.syscall) parts.push(`syscall=${cur.syscall}`);
      if (cur.hostname) parts.push(`host=${cur.hostname}`);
      if (cur.address) parts.push(`addr=${cur.address}${cur.port ? ':' + cur.port : ''}`);
      details.push(parts.join(' '));
    }
  }

  if (chain.length) out['net-cause'] = chain.join(' → ');
  if (details.length) out['net-detail'] = details[0];

  const netCode = codes[0];
  if (netCode) {
    out['net-code'] = netCode;
    const hint = NET_HINTS[netCode];
    if (hint) out['net-hint'] = hint;
  }
  return out;
}

/** 从 URL 里取 host（含端口），取不到时返回 '-' */
function hostOf(raw) {
  try {
    return new URL(String(raw)).host || '-';
  } catch {
    return '-';
  }
}

/**
 * HTTP 状态码 → 排查建议。订阅拉取失败时跟着日志一起打出。
 */
const HTTP_HINTS = {
  400: '请求被拒：订阅地址参数不完整或被改写',
  401: '未授权：token 无效或已过期',
  403: '禁止访问：订阅地址已失效，或拉取所用 UA 被机场安全规则拦截',
  404: '找不到该地址：订阅路径写错，或订阅已被机场删除',
  406: '对端不接受本次请求：UA / Accept 头被识别为异常客户端',
  429: '请求过于频繁：被机场限流，稍后重试',
  451: '因法律原因不可用：该订阅在当前地区被限制',
  500: '机场服务端错误：与本地无关，联系机场',
  502: '网关错误：机场上游异常',
  503: '服务不可用：机场维护或过载',
  504: '网关超时：机场上游超时',
};

function httpHint(status) {
  const s = Number(status);
  if (HTTP_HINTS[s]) return HTTP_HINTS[s];
  if (s >= 500) return '机场服务端错误：与本地无关';
  if (s >= 400) return '请求被拒绝：订阅地址可能已失效';
  return undefined;
}

function write(level, scope, msg, data) {
  let line = `${timestamp()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;

  if (data && typeof data === 'object') {
    const parts = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      parts.push(`${k}=${fmtValue(v)}`);
    }
    if (parts.length) line += ' ' + parts.join(' ');
  }
  line += '\n';

  if (LEVELS[level] >= FILE_LEVEL) emit(APP_LOG, line);
  if (LEVELS[level] >= LEVELS.warn) emit(ERR_LOG, line);

  if (LEVELS[level] >= CONSOLE_LEVEL) {
    (level === 'error' ? process.stderr : process.stdout).write(line);
  }
}

// ===================== 对外 API =====================

/**
 * 创建一个带 scope 的 logger。scope 会出现在每行日志的 [ ] 里，
 * 便于 grep 单个请求（如 `[sub#3f9a1c]`）或单个模块（如 `[parser]`）。
 *
 * @param {string} scope
 * @returns {{debug:Function,info:Function,warn:Function,error:Function,fail:Function}}
 */
function create(scope) {
  const s = scope || 'app';
  return {
    debug: (msg, data) => write('debug', s, msg, data),
    info: (msg, data) => write('info', s, msg, data),
    warn: (msg, data) => write('warn', s, msg, data),
    error: (msg, data) => write('error', s, msg, data),
    /**
     * 记录一个异常（含截断的调用栈与网络错误码）。catch 块统一用它，
     * 避免各处手写 err.message / err.stack 时漏掉栈，也避免只写下一句
     * 毫无信息量的 `fetch failed`。
     */
    fail: (msg, err, data) => {
      const d = describeError(err);
      return write('error', s, msg, {
        err: d.reason,
        code: d.code,
        'net-code': d['net-code'],
        'net-hint': d['net-hint'],
        'net-cause': d['net-cause'],
        'net-detail': d['net-detail'],
        ...(data || {}),
        stack: stackOf(err),
      });
    },
  };
}

/** 6 位十六进制请求号，用于把同一请求的多行日志串起来 */
function reqId() {
  return crypto.randomBytes(3).toString('hex');
}

/** 毫秒计时器：t.text() 得到 '842ms' / '1.9s' */
function timer() {
  const t0 = process.hrtime.bigint();
  return {
    ms: () => Number(process.hrtime.bigint() - t0) / 1e6,
    text() {
      return formatMs(this.ms());
    },
  };
}

function formatMs(ms) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 订阅地址脱敏。
 * 保留主机名与路径轮廓（才知道是哪家机场、哪个端点），
 * 抹掉 userinfo、常见凭据参数、以及路径里的长随机串（订阅路径本身就是凭据）。
 */
function safeUrl(raw) {
  let s = String(raw === null || raw === undefined ? '' : raw);
  if (!s) return '(空)';
  // https://user:pass@host/... → https://host/...
  s = s.replace(/\/\/[^@/]*@/g, '//');
  // ?token=xxx&code=yyy → ?token=***&code=***
  s = redactSecrets(s);
  // /AbCd1234...(≥24 位) → /***
  s = s.replace(/(\/[A-Za-z0-9_-]{24,})(?=[/?&#]|$)/g, '/***');
  return truncate(s);
}

/** 类型直方图，如 { vmess: 80, ss: 60 } */
function countBy(list, pick) {
  const out = {};
  for (const item of list || []) {
    const k = String(pick(item) || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = {
  create,
  reqId,
  timer,
  formatMs,
  formatBytes,
  safeUrl,
  preview,
  hostOf,
  httpHint,
  describeError,
  redactSecrets,
  countBy,
  // 供测试与诊断
  LOG_DIR,
  APP_LOG,
  ERR_LOG,
  level: {
    file: FILE_LEVEL,
    console: CONSOLE_LEVEL,
    fileName: FILE_LEVEL_NAME,
    consoleName: CONSOLE_LEVEL_NAME,
  },
};
