/**
 * 编码 / 解析工具
 */

/**
 * Base64 解码（同时兼容标准与 URL-safe 变体，自动补齐 padding）
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
 * 安全的 JSON 解析（失败返回 null，不抛异常）
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

module.exports = { base64Decode, safeJsonParse };
