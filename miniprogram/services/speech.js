const { callCloud, uploadToCloud } = require("./cloud");

function sanitizeSpeechText(text = "") {
  return `${text || ""}`
    .replace(/\[\d+:\d+(?:\.\d+)?,\d+:\d+(?:\.\d+)?\]\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function mergeSpeechText(originalText = "", nextText = "", multiline = true) {
  const base = `${originalText || ""}`.trim();
  const incoming = sanitizeSpeechText(nextText);

  if (!incoming) {
    return base;
  }

  if (!base) {
    return incoming;
  }

  return multiline ? `${base}\n${incoming}` : `${base} ${incoming}`;
}

function formatSpeechError(error) {
  const code = error && error.code ? error.code : "";
  const diagnosis = error && error.diagnosis ? error.diagnosis : "";
  const stage = error && error.stage ? error.stage : "";
  const requestId = error && error.requestId ? error.requestId : "";
  let message = error && error.message ? error.message : "语音转文字失败";

  if (code === "FailedOperation.UserNotRegistered") {
    message = "腾讯云语音识别服务未开通，需先开通 ASR";
  } else if (code === "SpeechConfigMissing") {
    message = "speech 云函数未配置腾讯云密钥";
  } else if (code === "AuthFailure.SecretIdNotFound" || code === "AuthFailure.InvalidSecretId") {
    message = "腾讯云 SecretId 无效，请检查 speech 云函数配置";
  } else if (code === "AuthFailure.SignatureFailure" || code === "AuthFailure.TokenFailure") {
    message = "腾讯云 SecretKey 无效，请检查 speech 云函数配置";
  } else if (code === "UnauthorizedOperation") {
    message = "腾讯云账号没有语音识别调用权限";
  } else if (code === "SpeechDownloadFailed") {
    message = "录音文件上传后读取失败，请重试";
  } else if (code === "SpeechTaskTimeout") {
    message = "语音识别超时，请缩短单次录音时长后重试";
  }

  return {
    message,
    code,
    stage,
    diagnosis,
    requestId
  };
}

async function transcribeVoiceFile(tempFilePath, options = {}) {
  if (!tempFilePath) {
    throw new Error("缺少语音文件");
  }

  const duration = Number(options.duration || 0);
  const cloudPath = options.cloudPath || `speech-input/${Date.now()}.mp3`;
  const fileID = await uploadToCloud(tempFilePath, cloudPath);

  const result = await callCloud("speech", {
    action: "transcribe",
    payload: {
      fileID,
      duration,
      language: options.language || "zh_CN"
    }
  });

  return {
    ...result,
    text: sanitizeSpeechText(result.text),
    fileID,
    tempFilePath
  };
}

module.exports = {
  formatSpeechError,
  mergeSpeechText,
  sanitizeSpeechText,
  transcribeVoiceFile
};
