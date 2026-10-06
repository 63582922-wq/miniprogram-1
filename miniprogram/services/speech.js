const { callCloud, uploadUserFile } = require("./cloud");

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
    message = "语音服务暂不可用，可以先输入文字";
  } else if (code === "SpeechConfigMissing") {
    message = "语音服务暂不可用，可以先输入文字";
  } else if (code === "AuthFailure.SecretIdNotFound" || code === "AuthFailure.InvalidSecretId") {
    message = "语音服务暂不可用，可以先输入文字";
  } else if (code === "AuthFailure.SignatureFailure" || code === "AuthFailure.TokenFailure") {
    message = "语音服务暂不可用，可以先输入文字";
  } else if (code === "UnauthorizedOperation") {
    message = "语音服务暂不可用，可以先输入文字";
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
  // 录音必须落到当前用户专属目录：speech 云函数会按 openId 校验路径归属，
  // 不这样做就等于把任意 fileID 交给云端下载，形成越权读取通道。
  const label = `${options.label || "voice"}`.replace(/[^\w-]/g, "") || "voice";
  // A retry should reuse the already uploaded recording instead of creating
  // another cloud object. Upload failures have no fileID, so those retry upload.
  const fileID = options.fileID || await uploadUserFile(tempFilePath, "speech-input", `${label}.mp3`);
  let result;
  try {
    result = await callCloud("speech", {
      action: "transcribe",
      payload: {
        fileID,
        duration,
        language: options.language || "zh_CN"
      }
    });
  } catch (error) {
    // Keep the uploaded media reference with the failure so the draft can
    // offer a safe retry without re-uploading the same audio.
    error.fileID = fileID;
    throw error;
  }

  const text = sanitizeSpeechText(result.text);
  if (!text) {
    const error = new Error("没有听清内容，请再试一次或直接输入文字");
    error.fileID = fileID;
    throw error;
  }
  return {
    ...result,
    text,
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
