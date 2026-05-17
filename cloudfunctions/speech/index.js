const cloud = require("wx-server-sdk");
const tencentcloud = require("tencentcloud-sdk-nodejs");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const AsrClient = tencentcloud.asr.v20190614.Client;

function createSpeechError(message, extra = {}) {
  const error = new Error(message);
  Object.assign(error, extra);
  return error;
}

function getRuntimeConfig() {
  const secretId = process.env.SPEECH_SECRET_ID || process.env.SECRET_ID || "";
  const secretKey = process.env.SPEECH_SECRET_KEY || process.env.SECRET_KEY || "";

  if (!secretId || !secretKey) {
    throw createSpeechError("请先在 speech 云函数环境变量中配置 SPEECH_SECRET_ID 和 SPEECH_SECRET_KEY", {
      code: "SpeechConfigMissing",
      stage: "config",
      diagnosis: "speech 云函数缺少腾讯云密钥配置"
    });
  }

  return {
    secretId,
    secretKey,
    region: process.env.SPEECH_REGION || "ap-guangzhou"
  };
}

function mapEngineModelType(language) {
  switch (language) {
    case "en_US":
      return "16k_en";
    case "yue":
      return "16k_yue";
    default:
      return "16k_zh";
  }
}

function detectVoiceFormat(fileID = "") {
  const matched = fileID.match(/\.([a-zA-Z0-9]+)$/);
  const extension = matched ? matched[1].toLowerCase() : "";
  if (["wav", "pcm", "ogg", "speex", "silk", "mp3", "m4a", "aac", "amr"].includes(extension)) {
    return extension;
  }
  return "mp3";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpeechError(error, fallback = {}) {
  const code = error && error.code ? error.code : (fallback.code || "SpeechError");
  const stage = error && error.stage ? error.stage : (fallback.stage || "unknown");
  const requestId = error && (error.requestId || error.RequestId)
    ? (error.requestId || error.RequestId)
    : (fallback.requestId || "");
  const message = error && error.message ? error.message : (fallback.message || "语音转文字失败");
  let diagnosis = error && error.diagnosis ? error.diagnosis : (fallback.diagnosis || "");
  let likelyCause = fallback.likelyCause || "";

  if (!diagnosis) {
    if (code === "FailedOperation.UserNotRegistered") {
      diagnosis = "腾讯云 ASR 服务未开通，或当前账号未注册该语音识别能力";
      likelyCause = "service_not_registered";
    } else if (code === "SpeechConfigMissing") {
      diagnosis = "speech 云函数缺少 SPEECH_SECRET_ID / SPEECH_SECRET_KEY";
      likelyCause = "missing_secret";
    } else if (code === "AuthFailure.SecretIdNotFound" || code === "AuthFailure.InvalidSecretId") {
      diagnosis = "腾讯云 SecretId 无效，请检查云函数环境变量";
      likelyCause = "invalid_secret_id";
    } else if (code === "AuthFailure.SignatureFailure" || code === "AuthFailure.TokenFailure") {
      diagnosis = "腾讯云密钥无效或签名失败，请检查 SecretKey";
      likelyCause = "invalid_secret_key";
    } else if (code === "UnauthorizedOperation") {
      diagnosis = "当前腾讯云账号没有 ASR 调用权限";
      likelyCause = "permission_denied";
    } else if (code === "SpeechDownloadFailed") {
      diagnosis = "云函数下载录音文件失败，请检查 fileID 或云存储权限";
      likelyCause = "download_failed";
    } else if (code === "SpeechEmptyFile") {
      diagnosis = "上传的录音文件为空或录音失败";
      likelyCause = "empty_audio";
    }
  }

  const normalized = {
    code,
    stage,
    message,
    requestId,
    diagnosis,
    likelyCause
  };

  if (error && error.firstError) {
    normalized.firstError = error.firstError;
  }

  return normalized;
}

function formatSpeechErrorMessage(errorInfo) {
  return `${errorInfo.code ? `${errorInfo.code}: ` : ""}${errorInfo.message || "语音转文字失败"}`;
}

function getConfigStatus() {
  const secretId = process.env.SPEECH_SECRET_ID || process.env.SECRET_ID || "";
  const secretKey = process.env.SPEECH_SECRET_KEY || process.env.SECRET_KEY || "";

  return {
    hasSpeechSecretId: Boolean(secretId),
    hasSpeechSecretKey: Boolean(secretKey),
    region: process.env.SPEECH_REGION || "ap-guangzhou"
  };
}

async function transcribe(payload) {
  if (!payload.fileID) {
    throw createSpeechError("缺少音频文件", {
      code: "SpeechMissingFile",
      stage: "validate"
    });
  }

  const runtimeConfig = getRuntimeConfig();
  let downloaded;
  try {
    downloaded = await cloud.downloadFile({
      fileID: payload.fileID
    });
  } catch (error) {
    throw createSpeechError(error.message || "音频文件下载失败", {
      code: error.code || "SpeechDownloadFailed",
      stage: "download",
      requestId: error.requestId || error.RequestId || "",
      diagnosis: "微信云存储文件下载失败，请检查 fileID 是否有效"
    });
  }
  const fileBuffer = downloaded.fileContent;

  if (!fileBuffer || !fileBuffer.length) {
    throw createSpeechError("音频文件为空", {
      code: "SpeechEmptyFile",
      stage: "download"
    });
  }

  const client = new AsrClient({
    credential: {
      secretId: runtimeConfig.secretId,
      secretKey: runtimeConfig.secretKey
    },
    region: runtimeConfig.region,
    profile: {
      httpProfile: {
        endpoint: "asr.tencentcloudapi.com"
      }
    }
  });

  const isShortAudio = Number(payload.duration || 0) > 0 && Number(payload.duration || 0) <= 60000 && fileBuffer.length <= 3 * 1024 * 1024;
  let firstError = null;

  if (isShortAudio) {
    try {
      const sentenceResult = await client.SentenceRecognition({
        EngSerViceType: mapEngineModelType(payload.language),
        SourceType: 1,
        VoiceFormat: detectVoiceFormat(payload.fileID),
        Data: Buffer.from(fileBuffer).toString("base64"),
        DataLen: fileBuffer.length,
        FilterDirty: 0,
        FilterModal: 0,
        FilterPunc: 0,
        ConvertNumMode: 1,
        WordInfo: 0
      });

      const text = (sentenceResult.Result || sentenceResult.Data && sentenceResult.Data.Result || "").trim();
      if (text) {
        return {
          text,
          requestId: sentenceResult.RequestId || "",
          duration: payload.duration || 0,
          mode: "sentence"
        };
      }
    } catch (error) {
      firstError = normalizeSpeechError(error, {
        stage: "sentence"
      });
    }
  }

  let createResult;
  try {
    createResult = await client.CreateRecTask({
      EngineModelType: mapEngineModelType(payload.language),
      ChannelNum: 1,
      ResTextFormat: 0,
      SourceType: 1,
      Data: Buffer.from(fileBuffer).toString("base64"),
      DataLen: fileBuffer.length,
      FilterDirty: 0,
      FilterModal: 0,
      FilterPunc: 0,
      ConvertNumMode: 1
    });
  } catch (error) {
    const taskError = createSpeechError(error.message || "转写任务创建失败", {
      code: error.code || "SpeechTaskCreateFailed",
      stage: "task_create",
      requestId: error.requestId || error.RequestId || ""
    });
    if (firstError) {
      taskError.firstError = firstError;
    }
    throw taskError;
  }
  const taskId = createResult.Data && createResult.Data.TaskId;

  if (!taskId) {
    throw createSpeechError("转写任务创建失败", {
      code: "SpeechTaskCreateFailed",
      stage: "task_create",
      requestId: createResult.RequestId || ""
    });
  }

  for (let index = 0; index < 25; index += 1) {
    await sleep(1000);
    let statusResult;
    try {
      statusResult = await client.DescribeTaskStatus({
        TaskId: taskId
      });
    } catch (error) {
      const pollError = createSpeechError(error.message || "转写结果查询失败", {
        code: error.code || "SpeechTaskPollFailed",
        stage: "task_poll",
        requestId: error.requestId || error.RequestId || createResult.RequestId || ""
      });
      if (firstError) {
        pollError.firstError = firstError;
      }
      throw pollError;
    }
    const statusData = statusResult.Data || {};

    if (statusData.Status === 2) {
      return {
        text: (statusData.Result || "").trim(),
        requestId: statusResult.RequestId || createResult.RequestId || "",
        duration: payload.duration || 0,
        mode: "task"
      };
    }

    if (statusData.Status === 3) {
      const taskFailedError = createSpeechError(statusData.ErrorMsg || "语音转文字失败", {
        code: statusData.ErrorMsg ? "SpeechTaskFailed" : "SpeechTaskFailed",
        stage: "task_poll",
        requestId: statusResult.RequestId || createResult.RequestId || ""
      });
      if (firstError) {
        taskFailedError.firstError = firstError;
      }
      throw taskFailedError;
    }
  }

  const timeoutError = createSpeechError("语音转文字处理超时，请缩短单次录音时长后重试", {
    code: "SpeechTaskTimeout",
    stage: "task_poll",
    requestId: createResult.RequestId || ""
  });
  if (firstError) {
    timeoutError.firstError = firstError;
  }
  throw timeoutError;
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  try {
    switch (action) {
      case "transcribe":
        return {
          success: true,
          data: await transcribe(payload)
        };
      case "diagnose":
        return {
          success: true,
          data: {
            config: getConfigStatus()
          }
        };
      default:
        return {
          success: false,
          message: "未知操作"
        };
    }
  } catch (error) {
    const normalized = normalizeSpeechError(error);
    return {
      success: false,
      message: formatSpeechErrorMessage(normalized),
      error: normalized
    };
  }
};
