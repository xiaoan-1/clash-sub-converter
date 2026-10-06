/**
 * 访客配置目录
 *
 * 为什么需要
 * ----------
 * 原先全站共用一份 config.json：部署到公网后，任何访问者改动配置都会影响所有人。
 * 现在按「访问者 IP」拆开，一个访客一个文件：
 *
 *   config/default.json   基准（纳入版本控制，所有内置分组定义）
 *   config.json           站点基准 —— 管理员自己的配置，也是所有访客的起点
 *   guests/<访客ID>.json  访客配置 —— 只存与站点基准的差异（gitignore）
 *
 * 生效顺序：default.json ← config.json ← guests/<ID>.json
 *
 * 谁用哪一份
 * ----------
 *   管理员（ADMIN_IPS 里列出的 IP；未启用反代时还包括回环地址）→ config.json
 *   其他所有访问者                                              → guests/<ID>.json
 *
 * 访客文件**只在保存配置时创建**（POST /api/config），读路径（GET /api/config、
 * GET /sub）不落盘 —— 否则任何人打开一次配置页、或爬虫扫一遍 /sub，guests/ 里
 * 就会多出一个文件；开着反向代理时连 X-Forwarded-For 都能随便编，可以无限刷。
 * 不存在的文件一律当作「空的差异」，所以首次访问看到的仍然是站点基准。
 *
 * 创建时写入的是**空的差异**（`{}`），因为访客层本来就叠加在站点基准之上 ——
 * 空的差异 = 完全继承站点基准，效果与「复制一份 config.json」完全一致。
 *
 * 这里故意不把 config.json 原样拷贝过去：拷贝会把访客锁死在创建那一刻的值上，
 * 以后管理员改站点基准，这些访客再也不会跟着变。要的是「一致的起点 + 各改各的」，
 * 而不是「各拿一份会过期的快照」。
 *
 * 三点必须知道的限制
 * ------------------
 *   1. 同一出口 IP 的人共用一份配置（家里多台设备、公司 NAT 出口都一样）。
 *      这是「按 IP 区分」的固有代价；要严格区分就得改用路径标识或登录态。
 *   2. 部署在 Nginx / Caddy 后面时**必须**设置 TRUST_PROXY，否则 req.ip 恒为
 *      127.0.0.1，所有访客会被当成同一个人；而且它的取值直接决定 req.ip 是否
 *      可被客户端伪造，见 parseTrustProxy()。
 *   3. 删除 guests/ 下的文件即重置该访客，服务无需重启（见 readGuestConfig）。
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const log = logger.create('guests');

const ROOT = path.join(__dirname, '..');
/** 访客配置目录 —— 一个访客一个文件 */
const GUEST_DIR = path.join(ROOT, 'guests');

// ===================== IP 规范化 =====================

/**
 * 把各种形态的客户端地址收敛成可比对的 IP。
 *
 *   '::ffff:127.0.0.1'      → '127.0.0.1'   （监听 :: 时 IPv4 连接会被映射成这种形式）
 *   '1.2.3.4, 10.0.0.1'     → '1.2.3.4'     （代理人多跳时 X-Forwarded-For 是逗号分隔列表）
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return '';
  let s = ip.trim();
  if (s.includes(',')) s = s.split(',')[0].trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  return s;
}

/**
 * 把 IP 转成安全的文件名。
 *
 * 只保留 [0-9a-zA-Z._-]，其余字符替换为 '_'：
 *   - 开启 trust proxy 后 req.ip 来自 X-Forwarded-For，是攻击者完全可控的输入，
 *     绝不能让 '/' 或 '\' 通过（否则可以读写 guests/ 之外的任何 JSON 文件）
 *   - IPv6 自带 ':'，在 Windows 上不能作文件名
 *
 * 另外因为写入时一定会追加 '.json' 后缀，而分隔符已被替换掉，
 * '..' 之类也构不成目录穿越（只会得到 guests/...json 这个普通文件名）。
 */
function normalizeGuestId(ip) {
  const cleaned = normalizeIp(ip).replace(/[^0-9a-zA-Z._-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'unknown';
  return cleaned;
}

/** 访客配置文件的绝对路径；ID 非法时抛错（兜底，正常不会触发） */
function guestFile(guestId) {
  const dir = path.resolve(GUEST_DIR);
  const file = path.join(dir, `${normalizeGuestId(guestId)}.json`);
  if (path.dirname(file) !== dir) {
    throw new Error(`非法的访客 ID: ${guestId}`);
  }
  return file;
}

// ===================== 管理员判定 =====================

/** 未启用反代时，回环地址就是管理员本机 */
const LOOPBACK_IPS = ['127.0.0.1', '::1'];

/** 环境变量 ADMIN_IPS 指定的管理员 IP（逗号 / 分号 / 空格分隔） */
const ADMIN_IPS = String(process.env.ADMIN_IPS || '')
  .split(/[,;\s]+/)
  .map(normalizeIp)
  .filter(Boolean);

/**
 * 当前生效的管理员 IP 列表。
 *
 * 回环地址只在**未启用反代**时算管理员：一旦部署在 Nginx 后面而没有正确设置
 * TRUST_PROXY，所有请求的 req.ip 都会是 127.0.0.1，此时再把回环地址当管理员
 * 就等于「所有访客共用管理员配置」——隔离会静默失效。所以开启反代后必须用
 * ADMIN_IPS 显式声明管理员的真实 IP。
 */
function adminIps(trustProxy) {
  return trustProxy ? [...ADMIN_IPS] : [...new Set([...LOOPBACK_IPS, ...ADMIN_IPS])];
}

function isAdminIp(ip, trustProxy) {
  const norm = normalizeIp(ip);
  if (!norm) return false;
  return adminIps(trustProxy).includes(norm);
}

// ===================== 请求 → 访客 =====================

/**
 * 解析 TRUST_PROXY 环境变量（同时用作 express 的 trust proxy 设置）。
 *
 *   未设置 / 0 / false → 关闭（直连部署，默认）
 *   1 / true           → 信任最近一跳（数字 1）
 *   loopback           → 只信任回环地址（本机反代）
 *   10.0.0.0/8         → 信任指定网段
 *   数字               → 信任前 N 跳
 *
 * ⚠️ '1' 和 'true' 都必须映射成**数字** 1，绝不能返回布尔 true。
 *    express 的 trust proxy = true 是「信任**所有**跳」：req.ip 会取
 *    X-Forwarded-For 的**最左**值，而那正是客户端自己写进去的字段 ——
 *    任何访客都能填一个 ADMIN_IPS 里的地址，把自己变成管理员去改站点基准。
 *    数字 1 才是「信任最近一跳」，从右往左取第一个不可信地址。
 *    已实测（X-Forwarded-For: '203.0.113.9, 9.9.9.9'）：
 *      trust proxy = true       → 203.0.113.9   ❌ 伪造成功
 *      trust proxy = 1          → 9.9.9.9       ✅
 *      trust proxy = 'loopback' → 9.9.9.9       ✅
 */
function parseTrustProxy(raw) {
  const v = String(raw || '').trim();
  if (!v || v === '0' || v.toLowerCase() === 'false') return false;
  // '1' / 'true' 一律当作「信任 1 跳」（见上方说明，不能返回布尔 true）
  if (v === '1' || v.toLowerCase() === 'true') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/** 本次请求的客户端 IP（拿不到时返回空串） */
function clientIp(req) {
  return normalizeIp(req.ip || (req.socket && req.socket.remoteAddress) || '');
}

/**
 * 本次请求应该用哪份配置。
 * @returns {string|null} 访客 ID；null 表示管理员，使用站点基准 config.json
 *
 * 取不到 IP 时也当作访客（归入 'unknown'），而不是放行到站点基准 ——
 * 万一出现异常情况，宁可让配置之间互相隔离，也不要暴露管理员的配置。
 */
function guestIdFrom(req) {
  const trustProxy = !!(req.app && req.app.get('trust proxy'));
  const ip = clientIp(req);
  if (ip && isAdminIp(ip, trustProxy)) return null;
  return normalizeGuestId(ip);
}

/** 供接口回显 / 日志用：这次请求的身份 */
function scopeOf(req) {
  const guest = guestIdFrom(req);
  return { ip: clientIp(req) || '(未知)', guest, admin: guest === null };
}

// ===================== 读写 =====================

/** 进程内已确认存在的访客，避免每次请求都去 stat 磁盘 */
const known = new Set();

/**
 * 访客文件数量上限（可用环境变量 MAX_GUESTS 覆盖）。
 * 文件只在保存配置时创建，正常部署远达不到这个数；设上限是为了防止有人脚本化地
 * 反复 POST /api/config（开着反向代理时 X-Forwarded-For 可以随便编）把磁盘刷爆。
 */
const MAX_GUESTS = Number(process.env.MAX_GUESTS) > 0 ? Number(process.env.MAX_GUESTS) : 1000;

/**
 * 新建访客配置文件（内容为空差异）。
 *
 * 只由写路径调用：读路径**不建文件**，否则陌生人打开一次配置页、爬虫扫一遍 /sub
 * 都会留下一个文件，开着反代时更是能无限制造文件。
 *
 * @returns {boolean} 本次是否新建了文件
 * @throws {Error} 访客数已达 MAX_GUESTS 时抛错（POST /api/config 会转成 500 返回）
 */
function createGuestConfig(guestId) {
  const id = normalizeGuestId(guestId);
  if (known.has(id)) return false;

  fs.mkdirSync(GUEST_DIR, { recursive: true });
  const file = guestFile(id);

  if (fs.existsSync(file)) {
    known.add(id);
    return false;
  }

  const total = listGuestIds().length;
  if (total >= MAX_GUESTS) {
    throw new Error(`访客数量已达上限 ${MAX_GUESTS}（可用环境变量 MAX_GUESTS 调整），拒绝为 ${id} 新建配置`);
  }

  // 空的差异 = 完全继承站点基准。不做 config.json 拷贝，理由见文件头注释。
  fs.writeFileSync(file, '{}\n', 'utf-8');
  known.add(id);
  log.info('新建访客配置（继承站点基准）', { guest: id, path: file, total: total + 1 });
  return true;
}

/**
 * 读取访客配置；文件不存在或损坏时返回空对象（即完全继承站点基准）。
 *
 * 读路径不创建文件：首次访问的访客看到的就是站点基准，只有他真的改了配置
 * （POST /api/config）才会生成 guests/<ID>.json。
 */
function readGuestConfig(guestId) {
  const id = normalizeGuestId(guestId);
  try {
    return JSON.parse(fs.readFileSync(guestFile(id), 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件不存在 = 该访客从未保存过，或运维刚把他重置掉（删文件即重置，无需重启）。
      // 同时清掉进程内缓存，否则删掉文件后每次请求都会走到下面的 fail 分支。
      known.delete(id);
      return {};
    }
    log.fail('访客配置解析失败，已回退为继承站点基准', err, { guest: id });
    return {};
  }
}

/** 写入访客配置（文件不存在时创建），返回文件路径 */
function writeGuestConfig(guestId, data) {
  const id = normalizeGuestId(guestId);
  createGuestConfig(id);
  const file = guestFile(id);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
  known.add(id);
  return file;
}

/** 已存在的访客 ID 列表（启动日志 / 运维查看用） */
function listGuestIds() {
  try {
    return fs
      .readdirSync(GUEST_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

module.exports = {
  GUEST_DIR,
  normalizeIp,
  normalizeGuestId,
  guestFile,
  adminIps,
  isAdminIp,
  parseTrustProxy,
  clientIp,
  guestIdFrom,
  scopeOf,
  MAX_GUESTS,
  createGuestConfig,
  readGuestConfig,
  writeGuestConfig,
  listGuestIds,
};
