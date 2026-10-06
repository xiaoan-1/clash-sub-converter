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
     * 记录一个异常（含截断的调用栈）。catch 块统一用它，
     * 避免各处手写 err.message / err.stack 时漏掉栈。
     */
    fail: (msg, err, data) => write('error', s, msg, {
      err: err && (err.message || String(err)),
      code: err && err.code,
      ...(data || {}),
      stack: stackOf(err),
    }),
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
  s = s.replace(/([?&](?:token|sub|code|key|auth|pwd|passwd|password|sign|secret|access_key)=)[^&#\s]*/gi, '$1***');
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
