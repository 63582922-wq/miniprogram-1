/**
 * 图片 URL 准入校验。
 *
 * PDF 服务用 Puppeteer 把调用方提交的数据渲染成 HTML，图片地址会直接进入 <img src>。
 * 如果不做限制，调用方可以提交 file:///etc/passwd 或指向内网的地址，
 * 让渲染器代为读取服务器本地文件、或探测内网服务——这就是 SSRF。
 *
 * 因此这里只放行「https + 已知对象存储域名」，其余一律置空。
 * 置空而不是抛错：单张图片异常不应该让整份报告生成失败。
 */

/**
 * 默认放行的域名后缀。
 * 均来自 wx.cloud.getTempFileURL 的返回结果与自建 CDN。
 */
const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  ".tcb.qcloud.la",
  ".myqcloud.com",
  ".haolizhiguan.cn"
];

/** 内网 / 本机 / 云元数据地址，无论是否在放行清单里都一律拒绝 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i
];

function getAllowedHostSuffixes() {
  const extra = `${process.env.PDF_ALLOWED_IMAGE_HOSTS || ""}`
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return DEFAULT_ALLOWED_HOST_SUFFIXES.concat(extra);
}

function isBlockedHost(hostname) {
  return BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

function isHostAllowed(hostname) {
  return getAllowedHostSuffixes().some((suffix) => {
    const bare = suffix.replace(/^\./, "");
    return hostname === bare || hostname.endsWith(suffix);
  });
}

/**
 * 校验并归一化一个图片地址。
 * 返回空字符串表示「不可用」，调用方应按无图处理。
 */
function sanitizeImageUrl(value) {
  if (typeof value !== "string") {
    return "";
  }

  const raw = value.trim();
  if (!raw) {
    return "";
  }

  const allowHttp = `${process.env.PDF_ALLOW_HTTP || ""}`.toLowerCase() === "true";
  const allowedProtocols = allowHttp ? ["https:", "http:"] : ["https:"];

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return "";
  }

  if (!allowedProtocols.includes(parsed.protocol)) {
    return "";
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHost(hostname)) {
    return "";
  }

  if (!isHostAllowed(hostname)) {
    return "";
  }

  return parsed.toString();
}

module.exports = {
  DEFAULT_ALLOWED_HOST_SUFFIXES,
  getAllowedHostSuffixes,
  sanitizeImageUrl
};
