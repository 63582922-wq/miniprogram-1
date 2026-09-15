/**
 * 云环境与运行配置的唯一来源。
 *
 * 为什么需要这个文件：
 * 环境 ID 原先硬编码在 app.js 里。环境一旦变更（续费、重建、切测试环境）就没有
 * 单一修改点；更严重的是初始化失败时只弹一个会消失的 toast，页面继续渲染
 * 「暂无项目」「暂无报告」这类空态，让人误以为是没有数据，而不是后端根本不可用。
 *
 * 使用方式：
 * 开通或更换云环境后，只改下面的 CLOUD_ENV_ID 一处即可。
 */

const { envList } = require("../envList");

/**
 * 当前云环境 ID。
 * 取自微信开发者工具 → 云开发控制台 → 设置 → 环境 ID。
 */
const CLOUD_ENV_ID = "cloud1-d4ge4gu1le8fe61d3";

/**
 * envList 由云开发模板 / 开发者工具自动写入，作为兜底来源。
 * 它的内容不由我们控制，所以只在 CLOUD_ENV_ID 为空时使用。
 */
function pickFromEnvList() {
  if (!Array.isArray(envList)) {
    return "";
  }
  const found = envList.find((item) => item && item.envId);
  return found ? found.envId : "";
}

function getCloudEnvId() {
  return CLOUD_ENV_ID || pickFromEnvList();
}

function isCloudEnvConfigured() {
  return Boolean(getCloudEnvId());
}

/**
 * 判断一个错误是不是「云环境不可用」这一类。
 *
 * 环境过期或 ID 错误时，wx.cloud.callFunction 会返回形如：
 *   cloud.callFunction fail ErrorCode: -501000 | errMsg: [{00003}] Env Not Exists
 * 这类错误不能当作「没有数据」处理，必须让用户看到真正的原因。
 */
function isCloudEnvError(error) {
  const text = [
    error && error.message,
    error && error.errMsg,
    error && error.code,
    error && error.errCode,
    JSON.stringify((error && error.firstError) || "")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    text.includes("env not exists") ||
    text.includes("invalid_env") ||
    text.includes("nvalid_env") ||
    text.includes("-501000") ||
    text.includes("cloud.callfunction fail")
  );
}

module.exports = {
  CLOUD_ENV_ID,
  getCloudEnvId,
  isCloudEnvConfigured,
  isCloudEnvError
};
