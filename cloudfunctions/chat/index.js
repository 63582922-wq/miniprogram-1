const cloud = require("wx-server-sdk");
const tencentcloud = require("tencentcloud-sdk-nodejs");
const axios = require("axios");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;
const HunyuanClient = tencentcloud.hunyuan.v20230901.Client;

function buildMockAnalysis(sourceText) {
  const lines = sourceText.split("\n").filter(Boolean);
  return {
    analysisSummary: `已分析 ${lines.length} 条聊天内容，识别出客户需求、供应商报价和待确认事项。`,
    requirements: [
      "客户关注材料环保等级与交付时间",
      "希望尽快确认瓷砖与木作样板",
      "要求报价拆分主材与辅材"
    ],
    quotations: [
      {
        vendor: "A供应商",
        price: "¥12800",
        note: "含配送，不含上楼"
      },
      {
        vendor: "B供应商",
        price: "¥13600",
        note: "含安装，交期7天"
      }
    ]
  };
}

function getAiRuntimeConfig() {
  const secretId = process.env.AI_SECRET_ID
    || process.env.SPEECH_SECRET_ID
    || process.env.TENCENTCLOUD_SECRET_ID
    || process.env.SECRET_ID
    || "";
  const secretKey = process.env.AI_SECRET_KEY
    || process.env.SPEECH_SECRET_KEY
    || process.env.TENCENTCLOUD_SECRET_KEY
    || process.env.SECRET_KEY
    || "";

  return {
    secretId,
    secretKey,
    region: process.env.AI_REGION || process.env.SPEECH_REGION || "ap-guangzhou",
    model: process.env.AI_MODEL || "hunyuan-lite",
    apiKey: process.env.AI_API_KEY || "",
    baseUrl: process.env.AI_BASE_URL || "",
    provider: process.env.AI_PROVIDER || "",
    thinkingEnabled: (process.env.AI_THINKING || "").toLowerCase() === "enabled"
  };
}

function getHunyuanClient() {
  const runtimeConfig = getAiRuntimeConfig();
  if (!runtimeConfig.secretId || !runtimeConfig.secretKey) {
    throw new Error("请先在 chat 云函数环境变量中配置 AI_SECRET_ID 和 AI_SECRET_KEY");
  }
  return new HunyuanClient({
    credential: {
      secretId: runtimeConfig.secretId,
      secretKey: runtimeConfig.secretKey
    },
    region: runtimeConfig.region,
    profile: {
      httpProfile: {
        endpoint: "hunyuan.tencentcloudapi.com"
      }
    }
  });
}

function extractAssistantText(response) {
  const possibleChoices = response && (response.Choices || response.choices || response.Response && response.Response.Choices) || [];
  const firstChoice = possibleChoices[0] || {};
  const message = firstChoice.Message || firstChoice.message || {};
  return (
    message.Content
    || message.content
    || firstChoice.Content
    || firstChoice.content
    || ""
  ).trim();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const matched = text.match(/\{[\s\S]*\}/);
    if (!matched) {
      throw error;
    }
    return JSON.parse(matched[0]);
  }
}

function isOpenAiCompatibleEnabled(runtimeConfig) {
  return Boolean(runtimeConfig.apiKey && runtimeConfig.baseUrl);
}

async function analyzeWithOpenAiCompatible(sourceText) {
  const runtimeConfig = getAiRuntimeConfig();
  const requestBody = {
    model: runtimeConfig.model,
    temperature: 0.2,
    response_format: {
      type: "json_object"
    },
    messages: [
      {
        role: "system",
        content: "你是装修项目聊天整理助手，请从聊天记录中提取摘要、需求、报价。必须返回 JSON。"
      },
      {
        role: "user",
        content: [
          "请分析以下聊天记录，并返回严格 JSON。",
          "格式：{\"analysisSummary\":\"\",\"requirements\":[\"\"],\"quotations\":[{\"vendor\":\"\",\"price\":\"\",\"note\":\"\"}]}",
          "聊天记录：",
          sourceText || ""
        ].join("\n")
      }
    ]
  };

  if (runtimeConfig.provider === "zhipu" || runtimeConfig.model.startsWith("glm-")) {
    requestBody.thinking = {
      type: runtimeConfig.thinkingEnabled ? "enabled" : "disabled"
    };
  }

  const response = await axios.post(
    `${runtimeConfig.baseUrl.replace(/\/$/, "")}/chat/completions`,
    requestBody,
    {
      headers: {
        Authorization: `Bearer ${runtimeConfig.apiKey}`,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );

  const choice = (((response || {}).data || {}).choices || [])[0] || {};
  const message = choice.message || {};
  const parsed = safeJsonParse(message.content || "");
  return {
    analysisSummary: parsed.analysisSummary || "已完成聊天整理。",
    requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
    quotations: Array.isArray(parsed.quotations) ? parsed.quotations : []
  };
}

async function analyzeWithModel(sourceText) {
  const runtimeConfig = getAiRuntimeConfig();
  if (isOpenAiCompatibleEnabled(runtimeConfig)) {
    return analyzeWithOpenAiCompatible(sourceText);
  }

  const client = getHunyuanClient();
  const response = await client.ChatCompletions({
    Model: runtimeConfig.model,
    Stream: false,
    Temperature: 0.2,
    Messages: [
      {
        Role: "system",
        Content: "你是装修项目聊天整理助手，请从聊天记录中提取摘要、需求、报价。必须返回 JSON。"
      },
      {
        Role: "user",
        Content: [
          "请分析以下聊天记录，并返回严格 JSON。",
          "格式：{\"analysisSummary\":\"\",\"requirements\":[\"\"],\"quotations\":[{\"vendor\":\"\",\"price\":\"\",\"note\":\"\"}]}",
          "聊天记录：",
          sourceText || ""
        ].join("\n")
      }
    ]
  });

  const parsed = safeJsonParse(extractAssistantText(response));
  return {
    analysisSummary: parsed.analysisSummary || "已完成聊天整理。",
    requirements: Array.isArray(parsed.requirements) ? parsed.requirements : [],
    quotations: Array.isArray(parsed.quotations) ? parsed.quotations : []
  };
}

async function analyze(payload) {
  const { OPENID } = cloud.getWXContext();
  if (payload.projectId) {
    const proj = await db.collection("projects").doc(payload.projectId).get();
    const project = proj.data;
    if (!project || project.deleted || project.ownerOpenId !== OPENID) {
      return {
        success: false,
        message: "无权在该项目下保存分析"
      };
    }
  }
  const now = Date.now();
  let result;
  let aiMode = "fallback";

  try {
    result = await analyzeWithModel(payload.sourceText || "");
    aiMode = "model";
  } catch (error) {
    result = buildMockAnalysis(payload.sourceText || "");
  }

  const data = {
    projectId: payload.projectId || "",
    sourceText: payload.sourceText || "",
    analysisSummary: result.analysisSummary,
    requirements: result.requirements,
    quotations: result.quotations,
    aiRawResult: result,
    aiMode,
    status: "completed",
    deleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: OPENID,
    updatedBy: OPENID
  };
  const created = await db.collection("chat_analysis").add({
    data
  });

  return {
    success: true,
    data: {
      ...data,
      _id: created._id
    }
  };
}

async function list(payload) {
  const { OPENID } = cloud.getWXContext();
  const projects = await db.collection("projects").where({
    ownerOpenId: OPENID,
    deleted: false
  }).get();
  const projectIds = (projects.data || []).map((item) => item._id);

  if (payload.projectId) {
    if (!projectIds.includes(payload.projectId)) {
      return {
        success: true,
        data: {
          list: [],
          total: 0
        }
      };
    }
    const scoped = await db.collection("chat_analysis").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc").get();
    return {
      success: true,
      data: {
        list: scoped.data || [],
        total: (scoped.data || []).length
      }
    };
  }

  const orList = [
    {
      createdBy: OPENID
    }
  ];
  if (projectIds.length) {
    orList.push({
      projectId: _.in(projectIds)
    });
  }
  const result = await db.collection("chat_analysis").where(
    _.and([
      {
        deleted: false
      },
      _.or(orList)
    ])
  ).orderBy("createdAt", "desc").get();

  return {
    success: true,
    data: {
      list: result.data || [],
      total: (result.data || []).length
    }
  };
}

async function detail(payload) {
  if (!payload.analysisId) {
    return {
      success: false,
      message: "缺少聊天整理记录ID"
    };
  }

  const { OPENID } = cloud.getWXContext();
  const result = await db.collection("chat_analysis").doc(payload.analysisId).get();
  const row = result.data;
  if (!row || row.deleted) {
    return {
      success: true,
      data: null
    };
  }
  if (row.projectId) {
    const proj = await db.collection("projects").doc(row.projectId).get();
    const project = proj.data;
    if (!project || project.deleted || project.ownerOpenId !== OPENID) {
      return {
        success: false,
        message: "无权查看该记录"
      };
    }
  } else if (row.createdBy !== OPENID) {
    return {
      success: false,
      message: "无权查看该记录"
    };
  }
  return {
    success: true,
    data: row
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "analyze":
      return analyze(payload);
    case "list":
      return list(payload);
    case "detail":
      return detail(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
