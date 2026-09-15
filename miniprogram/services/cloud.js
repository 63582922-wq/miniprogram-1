function toReadableText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${value}`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toReadableText(item)).filter(Boolean).join(" ");
  }
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return `${value}`;
  }
}

function normalizeMiniProgramErrorText(error) {
  if (!error) {
    return "";
  }
  const parts = [
    error.errMsg,
    error.message,
    error.diagnosis,
    error.likelyCause,
    error.errCode,
    error.code
  ].map((item) => toReadableText(item)).filter(Boolean);
  return parts.join(" ").trim();
}

function looksLikeTimeoutError(error) {
  const text = normalizeMiniProgramErrorText(error);
  return /timeout|timed out|超时/i.test(text);
}

function createCloudError(message, extra = {}) {
  const error = new Error(message || "云函数调用失败");
  Object.assign(error, extra);
  return error;
}

async function callCloud(name, data = {}) {
  const action = data && data.action ? data.action : "";
  const invoke = () => wx.cloud.callFunction({
    name,
    data,
    timeout: 60000
  });
  try {
    let result;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        result = await invoke();
        break;
      } catch (invokeError) {
        const retryable = looksLikeTimeoutError(invokeError) && attempt < maxAttempts;
        if (!retryable) {
          throw invokeError;
        }
        const backoff = 400 * attempt * attempt;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    const payload = result.result || {};

    if (payload.success === false) {
      throw createCloudError(payload.message || "云函数调用失败", payload.error || {});
    }

    return payload.data === undefined ? payload : payload.data;
  } catch (error) {
    const reason =
      normalizeMiniProgramErrorText(error) || "网络异常，请稍后重试";
    throw createCloudError(`[${name}${action ? `:${action}` : ""}] ${reason}`, {
      code: error.code || "",
      stage: error.stage || "",
      requestId: error.requestId || "",
      diagnosis: error.diagnosis || "",
      likelyCause: error.likelyCause || "",
      firstError: error.firstError || null
    });
  }
}

async function uploadToCloud(filePath, cloudPath) {
  try {
    const result = await wx.cloud.uploadFile({
      cloudPath,
      filePath
    });

    return result.fileID;
  } catch (error) {
    throw createCloudError(error.message || error.errMsg || "云文件上传失败", {
      code: error.code || "",
      stage: "upload",
      diagnosis: error.errMsg || "",
      likelyCause: "wx.cloud.uploadFile failed"
    });
  }
}

/** 当前登录用户的 openId，取自启动时的 bootstrap 结果 */
function getCurrentOpenId() {
  try {
    const app = getApp();
    const userInfo = app && app.globalData ? app.globalData.userInfo : null;
    return (userInfo && userInfo.openId) || "";
  } catch (_error) {
    return "";
  }
}

/**
 * 按 openId 隔离的云存储路径。
 *
 * 云存储的 fileID 本身就是读取凭据——拿到就能读。路径不按用户隔离时，
 * 只要 fileID 外泄（日志、分享、他人提交的载荷），就能读走别人的工地照片和录音。
 * 因此所有上传都必须落到 user/{openId}/ 下面，云端再做归属校验。
 */
function buildUserScopedPath(folder, fileName) {
  const openId = getCurrentOpenId();
  if (!openId) {
    throw createCloudError("尚未完成登录，请稍后重试", {
      stage: "uploadScope",
      likelyCause: "app.globalData.userInfo.openId is empty"
    });
  }

  const safeFolder = `${folder || "files"}`.replace(/^\/+|\/+$/g, "");
  return `${safeFolder}/user/${openId}/${Date.now()}-${fileName}`;
}

/** 上传到当前用户专属目录，返回 fileID */
function uploadUserFile(filePath, folder, fileName) {
  return uploadToCloud(filePath, buildUserScopedPath(folder, fileName));
}

module.exports = {
  callCloud,
  uploadToCloud,
  buildUserScopedPath,
  uploadUserFile,
  getCurrentOpenId
};
