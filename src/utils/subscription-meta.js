/**
 * 订阅元信息解析
 *
 * 机场通过响应头下发流量 / 到期 / 官网 / 更新间隔 / 文件名，
 * 这些头要原样转发给客户端，否则 Clash 面板上的订阅详情是空白。
 */

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
 * 注意空值必须跳过：`Number('')` 是 0（有限且 >= 0），若不过滤会把
 * `total=` / `expire=` 这类空字段当成 0 写出去，客户端会显示「总流量 0」。
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
    const raw = part.slice(idx + 1).trim();
    if (!raw) continue;   // 空值跳过，不能当成 0
    const num = Number(raw);
    // 只接受十进制整数：排除 Infinity / 科学计数法 / 十六进制等异常写法
    if (!/^\d+$/.test(raw) || !Number.isFinite(num)) continue;
    const n = Math.floor(num);
    // 上界约束：expire 为 Unix 时间戳（2100 年前），其余为字节数（≤ 1 PiB）
    const limit = key === 'expire' ? 4102444800 : 1024 ** 5;
    if (n > limit) continue;
    info[key] = n;
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

module.exports = {
  readSubHeader,
  parseUserInfo,
  mergeUserInfo,
  formatUserInfo,
  sanitizeHomeUrl,
  parseUpdateInterval,
  parseFileName,
  buildContentDisposition,
};
