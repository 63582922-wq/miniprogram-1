const cloud = require("wx-server-sdk");
const tencentcloud = require("tencentcloud-sdk-nodejs");
const axios = require("axios");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const HunyuanClient = tencentcloud.hunyuan.v20230901.Client;
const db = cloud.database();
const _ = db.command;
const AI_TASK_COLLECTION = "ai_tasks";

const SEVERITY_LABEL_MAP = {
  critical: "严重",
  major: "较重",
  normal: "一般",
  minor: "一般"
};

const RESPONSIBLE_PARTY_LABEL_MAP = {
  constructor: "施工方",
  supplier: "供应方",
  client: "业主",
  pending: "待确认"
};

const GENERIC_CATEGORY_NAMES = ["施工", "现场问题", "问题", "其他"];
const GENERIC_AREA_NAMES = ["地面", "现场", "现场问题", "问题区域", "其他区域"];
const AI_BATCH_SIZE = 2;
const AI_BATCH_PARALLEL_LIMIT = 3;

/**
 * AI 任务记录的保留时长。
 * 任务里带着完整的草稿载荷（图片路径、语音文本），失败或被用户放弃的任务
 * 原先会永久堆积，既占存储也留着数据。这里给一个 7 天 TTL 便于定期清理。
 */
const AI_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 校验调用者是否有权访问某个项目。
 *
 * 本函数此前完全缺失，导致三个后果：
 * 1. analyzeInspection / createInspectionTask 可被任意登录用户传入别人的 projectId，
 *    消耗账号的付费模型额度；
 * 2. buildProjectHistoryMemory 会把他人项目的问题分类、区域统计和巡查摘要
 *    通过 memoryHint / memoryAlerts 回吐给调用者，造成跨租户经营数据泄露；
 * 3. ai_tasks 不记录归属，getInspectionTaskStatus 只要猜到 taskId
 *    就能拿到他人的问题描述、图片路径和语音文本。
 */
async function assertProjectAccess(projectId, openId) {
  if (!projectId) {
    return { ok: false, message: "缺少项目 ID" };
  }

  let project = null;
  try {
    const doc = await db.collection("projects").doc(projectId).get();
    project = doc.data;
  } catch (error) {
    // 文档不存在时 SDK 会抛错，统一按无权限处理，避免泄露资源是否存在
    return { ok: false, message: "无权访问该项目" };
  }

  if (!project || project.deleted || project.ownerOpenId !== openId) {
    return { ok: false, message: "无权访问该项目" };
  }

  return { ok: true, project };
}

function hasMeaningfulVoiceText(text = "") {
  return `${text || ""}`.trim().length > 0;
}

function shouldSkipImageRecognitionForDraft(draft = {}) {
  return hasMeaningfulVoiceText(draft.voiceText);
}

function polishVoiceDescriptionText(text = "") {
  let normalized = `${text || ""}`.trim();
  if (!normalized) {
    return "";
  }
  normalized = normalized
    .replace(/\s+/g, "")
    .replace(/[；;]/g, "，")
    .replace(/[!！]+/g, "。")
    .replace(/[?？]+/g, "。");
  normalized = normalized.replace(/^(嗯+|啊+|呃+|额+|那个|这个|就是|然后呢|然后|我看|我觉得|感觉|好像)+/g, "");
  normalized = normalized.replace(/(啊|呀|吧|呢|哦|嘛)+(?=[，。；,.;]|$)/g, "");
  normalized = normalized.replace(/，{2,}/g, "，").replace(/。{2,}/g, "。");
  normalized = normalized.replace(/^，+|，+$/g, "");
  if (normalized && !/[。]$/.test(normalized)) {
    normalized = `${normalized}。`;
  }
  return normalized;
}

function resolveIssueDescription(rawDescription = "", draft = {}, itemIndex = 0) {
  const description = `${rawDescription || ""}`.trim();
  if (description) {
    return shouldSkipImageRecognitionForDraft(draft)
      ? polishVoiceDescriptionText(description)
      : description;
  }
  if (draft.voiceText) {
    return polishVoiceDescriptionText(draft.voiceText);
  }
  return `第 ${itemIndex + 1} 张照片存在待确认问题，请结合照片和标注复核。`;
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
    throw new Error("请先在 ai 云函数环境变量中配置 AI_SECRET_ID 和 AI_SECRET_KEY");
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
    const matched = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!matched) {
      throw error;
    }
    return JSON.parse(matched[0]);
  }
}

function isOpenAiCompatibleEnabled(runtimeConfig) {
  return Boolean(runtimeConfig.apiKey && runtimeConfig.baseUrl);
}

function mapSeverityLabel(value = "") {
  return SEVERITY_LABEL_MAP[value] || value || "未填写";
}

function mapResponsiblePartyLabel(value = "") {
  return RESPONSIBLE_PARTY_LABEL_MAP[value] || value || "待确认";
}

function getTopBucketEntries(bucket = {}, limit = 2) {
  return Object.entries(bucket)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([name, count]) => ({
      name,
      count
    }));
}

async function loadInspectionItemsByInspectionIds(inspectionIds = []) {
  if (!inspectionIds.length) {
    return [];
  }
  const result = await db.collection("inspection_items").where({
    inspectionId: _.in(inspectionIds),
    deleted: false
  }).get();
  return result.data || [];
}

async function buildUserPreferenceMemory(openId) {
  if (!openId) {
    return {
      applied: false,
      lines: []
    };
  }

  try {
    const inspections = await db.collection("inspections").where({
      inspectorOpenId: openId,
      deleted: false
    }).orderBy("createdAt", "desc").limit(8).get();
    const inspectionIds = (inspections.data || []).map((item) => item._id).filter(Boolean);
    const items = await loadInspectionItemsByInspectionIds(inspectionIds);

    const severityCorrections = {};
    const responsibleCorrections = {};
    const categoryCorrections = {};
    let descriptionRewriteCount = 0;

    (items || []).forEach((item) => {
      const aiRawResult = item.aiRawResult || {};

      if (aiRawResult.severity && item.severity && aiRawResult.severity !== item.severity) {
        const key = `${mapSeverityLabel(aiRawResult.severity)} -> ${mapSeverityLabel(item.severity)}`;
        severityCorrections[key] = (severityCorrections[key] || 0) + 1;
      }

      if (aiRawResult.responsibleParty && item.responsibleParty && aiRawResult.responsibleParty !== item.responsibleParty) {
        const key = `${mapResponsiblePartyLabel(aiRawResult.responsibleParty)} -> ${mapResponsiblePartyLabel(item.responsibleParty)}`;
        responsibleCorrections[key] = (responsibleCorrections[key] || 0) + 1;
      }

      if (aiRawResult.category && item.category && aiRawResult.category !== item.category) {
        const key = `${aiRawResult.category} -> ${item.category}`;
        categoryCorrections[key] = (categoryCorrections[key] || 0) + 1;
      }

      if (aiRawResult.description && item.description && aiRawResult.description.trim() !== item.description.trim()) {
        descriptionRewriteCount += 1;
      }
    });

    const lines = [];
    const topSeverityCorrectionEntry = getTopBucketEntries(severityCorrections, 1)[0];
    const topResponsibleCorrectionEntry = getTopBucketEntries(responsibleCorrections, 1)[0];
    const topCategoryCorrectionEntry = getTopBucketEntries(categoryCorrections, 1)[0];
    const topSeverityCorrection = topSeverityCorrectionEntry ? `${topSeverityCorrectionEntry.name}${topSeverityCorrectionEntry.count}次` : "";
    const topResponsibleCorrection = topResponsibleCorrectionEntry ? `${topResponsibleCorrectionEntry.name}${topResponsibleCorrectionEntry.count}次` : "";
    const topCategoryCorrection = topCategoryCorrectionEntry ? `${topCategoryCorrectionEntry.name}${topCategoryCorrectionEntry.count}次` : "";

    if (topSeverityCorrection) {
      lines.push(`你的历史修正里，严重级最常调整为：${topSeverityCorrection}。`);
    }
    if (topResponsibleCorrection) {
      lines.push(`你的历史修正里，责任方最常调整为：${topResponsibleCorrection}。`);
    }
    if (topCategoryCorrection) {
      lines.push(`你的历史修正里，问题分类最常调整为：${topCategoryCorrection}。`);
    }
    if (descriptionRewriteCount >= 3) {
      lines.push(`你最近多次会重写 AI 的问题描述，请尽量输出更贴近监理巡查口吻的描述。`);
    }

    return {
      applied: lines.length > 0,
      lines,
      topSeverityCorrection: topSeverityCorrectionEntry || null,
      topResponsibleCorrection: topResponsibleCorrectionEntry || null,
      topCategoryCorrection: topCategoryCorrectionEntry || null,
      descriptionRewriteCount
    };
  } catch (error) {
    console.error("buildUserPreferenceMemory failed", error);
    return {
      applied: false,
      lines: [],
      topSeverityCorrection: null,
      topResponsibleCorrection: null,
      topCategoryCorrection: null,
      descriptionRewriteCount: 0
    };
  }
}

async function buildProjectHistoryMemory(projectId) {
  if (!projectId) {
    return {
      applied: false,
      lines: []
    };
  }

  try {
    const inspections = await db.collection("inspections").where({
      projectId,
      deleted: false
    }).orderBy("createdAt", "desc").limit(3).get();
    const inspectionList = inspections.data || [];
    const inspectionIds = inspectionList.map((item) => item._id).filter(Boolean);
    const items = await loadInspectionItemsByInspectionIds(inspectionIds);

    if (!inspectionList.length || !items.length) {
      return {
        applied: false,
        lines: []
      };
    }

    const categoryBucket = {};
    const areaBucket = {};
    let highSeverityCount = 0;

    items.forEach((item) => {
      if (item.category) {
        categoryBucket[item.category] = (categoryBucket[item.category] || 0) + 1;
      }
      if (item.area) {
        areaBucket[item.area] = (areaBucket[item.area] || 0) + 1;
      }
      if (item.severity === "critical" || item.severity === "major") {
        highSeverityCount += 1;
      }
    });

    const lines = [
      `本项目最近 ${inspectionList.length} 次巡查共记录 ${items.length} 条问题。`
    ];
    const topCategoryEntries = getTopBucketEntries(categoryBucket, 2);
    const topAreaEntries = getTopBucketEntries(areaBucket, 2);
    const topCategories = topCategoryEntries.map((item) => `${item.name}${item.count}项`);
    const topAreas = topAreaEntries.map((item) => `${item.name}${item.count}项`);
    if (topCategories.length) {
      lines.push(`高频问题分类：${topCategories.join("、")}。`);
    }
    if (topAreas.length) {
      lines.push(`高频问题区域：${topAreas.join("、")}。`);
    }
    if (highSeverityCount) {
      lines.push(`其中较重及严重问题共 ${highSeverityCount} 条，判断时可优先关注重复高风险缺陷。`);
    }

    const recentSummaries = inspectionList
      .map((item) => (item.aiSummary || "").trim())
      .filter(Boolean)
      .slice(0, 2);
    if (recentSummaries.length) {
      lines.push(`最近巡查摘要：${recentSummaries.join("；")}。`);
    }

    return {
      applied: lines.length > 0,
      lines,
      topCategories: topCategoryEntries,
      topAreas: topAreaEntries,
      highSeverityCount
    };
  } catch (error) {
    console.error("buildProjectHistoryMemory failed", error);
    return {
      applied: false,
      lines: [],
      topCategories: [],
      topAreas: [],
      highSeverityCount: 0
    };
  }
}

function buildMemoryAlerts(payload = {}, items = []) {
  const alerts = [];
  const aiMemory = payload.aiMemory || {};
  const projectHistory = aiMemory.projectHistory || {};
  const userPreference = aiMemory.userPreference || {};
  const currentCategories = new Set((items || []).map((item) => item.category).filter(Boolean));
  const currentAreas = new Set((items || []).map((item) => item.area).filter(Boolean));

  const matchedCategory = (projectHistory.topCategories || []).find((item) => currentCategories.has(item.name) && !GENERIC_CATEGORY_NAMES.includes(item.name));
  if (matchedCategory) {
    alerts.push(`本次结果与本项目历史高频分类“${matchedCategory.name}”一致，建议重点关注重复问题。`);
  }

  const matchedArea = (projectHistory.topAreas || []).find((item) => currentAreas.has(item.name) && !GENERIC_AREA_NAMES.includes(item.name));
  if (matchedArea) {
    alerts.push(`当前问题涉及历史高频区域“${matchedArea.name}”，可重点复核该区域的重复缺陷。`);
  }

  if (userPreference.topSeverityCorrection && userPreference.topSeverityCorrection.name) {
    alerts.push(`你最近经常会调整严重级判定（${userPreference.topSeverityCorrection.name}），建议复核本次问题等级。`);
  }

  if (userPreference.topResponsibleCorrection && userPreference.topResponsibleCorrection.name) {
    alerts.push(`你最近经常会修正责任方判定（${userPreference.topResponsibleCorrection.name}），建议关注责任方归属是否准确。`);
  }

  return alerts.slice(0, 3);
}

async function enrichPayloadWithMemory(payload = {}) {
  const { OPENID } = cloud.getWXContext();
  const [userPreference, projectHistory] = await Promise.all([
    buildUserPreferenceMemory(OPENID),
    buildProjectHistoryMemory(payload.projectId)
  ]);

  const memoryHintParts = [];
  if (projectHistory.applied) {
    memoryHintParts.push("已结合本项目历史巡查记录");
  }
  if (userPreference.applied) {
    memoryHintParts.push("已参考你的修正习惯");
  }

  return Object.assign({}, payload, {
    aiMemory: {
      userPreference,
      projectHistory
    },
    memoryHint: memoryHintParts.join("，")
  });
}

function getInspectionAiJsonSchema() {
  return JSON.stringify({
    items: [
      {
        sourceIndex: 0,
        subIssueIndex: 1,
        area: "",
        category: "",
        severity: "critical|major|normal",
        responsibleParty: "constructor|supplier|client|pending",
        description: "",
        suggestion: "",
        visualEvidence: "",
        evidenceSource: "image|note|image+note",
        images: [],
        annotatedImages: [],
        annotations: [],
        voiceText: "",
        voiceStorageFileId: "",
        voiceFilePath: "",
        voiceFileId: ""
      }
    ],
    summary: ""
  });
}

function getInspectionAiSystemPrompt() {
  return [
    "你是装修巡查问题结构化整理引擎，不是聊天助手。你的输出将直接用于巡查结果确认、报告分组和 PDF 生成。",
    "",
    "你的任务分为五层：",
    "1. 以每张问题照片为独立分析单元，绝不跨照片合并问题。",
    "2. 判断同一张照片里的现场补充、语音转写文字和标注信息，描述的是一个问题的多个细节，还是多个独立问题。",
    "3. 同一张照片里，只要某个细节可以独立成立、独立核验、独立整改，就应拆成 1 条独立子问题。",
    "4. 如果是同一张照片里的多个独立问题，拆成多条问题项；这些问题项必须共享同一个 sourceIndex，并按 1 开始递增 subIssueIndex。",
    "5. 只有当多句描述明显只是同一个问题的补充说明、后果描述或同义复述时，才允许合并为 1 条子问题。",
    "6. 如果某张照片没有任何语音或文字输入，也必须仅根据照片内容和标注信息独立识别并输出至少 1 条问题项。",
    "7. 每条问题项都要补足结构化字段，并输出 summary。",
    "",
    "判断同图是否应该拆分为多个独立问题时，使用以下规则：",
    "- 若描述指向不同构件、不同区域、不同缺陷类型、不同整改动作，拆分为多个问题。",
    "- 若一个细节本身可以单独写成一条问题描述并给出独立整改建议，就拆分为独立子问题。",
    "- 若描述只是同一缺陷的补充说明、后果说明、程度说明、位置补充或同义复述，不拆分。",
    "- 优先按“是否可独立核验、是否可独立整改”判断；只要可以独立核验或独立整改，通常就应拆分。",
    "- 不允许为了简化输出而吞掉语音中明确提到的独立缺陷点。",
    "- 不允许为了凑数量而机械拆分同义描述。",
    "",
    "输出规则：",
    "- 返回严格 JSON，不要输出 Markdown、解释、注释或额外文字。",
    "- items 是扁平数组，但同一张照片的多个问题必须拥有相同 sourceIndex，并使用 subIssueIndex 表示该照片下的第几个子问题。",
    "- 每张照片至少产出 1 条问题项，不允许漏掉任何一张照片。",
    "- 当某条问题主要依据语音转写整理时，description 必须润色成书面化、可直接用于巡查确认和 PDF 的问题描述，不能直接照抄口语原文。",
    "- 需要把“这个、那里、有点、好像、然后、就是”等口语化表达整理成正式巡查表述，并去掉语气词、重复词和填充词。",
    "- visualEvidence 必须写你从图片或标注中真正观察到的证据，不能只复述语音文字。",
    "- 当没有语音转写文字时，仍要根据图片和标注自行判断问题，不允许因为缺少文字输入而返回空结果。",
    "- 若无法确认责任方或等级，可保守输出 pending / normal，但不要编造不存在的证据。",
    "- images、annotatedImages、annotations、voiceText、voiceStorageFileId、voiceFilePath、voiceFileId 由后处理补全；模型无需编造真实文件路径，可返回空数组或空字符串。",
    "- 语音里明确点名的每个独立缺陷，必须在 items 中保留，不允许遗漏。",
    "",
    "错误示例：",
    "- 把语音里明确提到的‘管卡颜色不一致’直接吞掉，只保留另一个问题。",
    "- 把同一张照片里‘线管弯折’和‘插座底盒歪斜’合并成一个问题。",
    "- 只复述语音内容，不写图片证据。",
    "",
    "正确目标：",
    "- 模型输出能直接支持‘一张照片一个一级问题块，右侧多个子问题条目’的报告结构。",
    "- 同图多问题时，sourceIndex 相同，subIssueIndex 为 1/2/3/4。",
    "",
    "必须返回可解析 JSON。"
  ].join("\n");
}

function getInspectionAiUserInstructionLines(payload) {
  const lines = [
    "请基于以下巡查草稿进行结构化整理。",
    `项目名称：${payload.projectName || ""}`,
    `巡查标题：${payload.title || ""}`,
    `现场补充：${payload.note || ""}`,
    "输出 JSON Schema：",
    getInspectionAiJsonSchema(),
    "",
    "请特别遵守：",
    "1. 不跨照片合并。",
    "2. 同图里可独立成立、独立核验、独立整改的细节，默认拆成多个子问题。",
    "3. 若同图有多个独立问题，统一保留同一个 sourceIndex，用 subIssueIndex 标记该照片下的 1/2/3/4。",
    "4. 只有明显属于同一个问题的补充说明时，才合并到同一个子问题。",
    "5. 语音中明确说出的独立缺陷点不允许遗漏。",
    "6. 若没有语音或文字输入，也必须根据照片和标注自行输出问题。"
  ];

  const aiMemory = payload.aiMemory || {};
  if (aiMemory.projectHistory && aiMemory.projectHistory.lines && aiMemory.projectHistory.lines.length) {
    lines.push("", "请参考当前项目历史巡查记录：", ...aiMemory.projectHistory.lines);
  }
  if (aiMemory.userPreference && aiMemory.userPreference.lines && aiMemory.userPreference.lines.length) {
    lines.push("", "请参考用户的历史修正习惯：", ...aiMemory.userPreference.lines);
  }
  if ((aiMemory.projectHistory && aiMemory.projectHistory.applied) || (aiMemory.userPreference && aiMemory.userPreference.applied)) {
    lines.push("", "若当前图片证据与历史习惯或历史项目记录冲突，优先以当前图片、标注和现场补充信息为准。");
  }

  return lines;
}

function normalizeIssueClauseText(text = "") {
  return `${text}`
    .replace(/^(这个|这里|现场|图片里|图中|该处)/, "")
    .replace(/^(还有|另有|另外|以及|并且|而且|同时|且)/, "")
    .trim();
}

function isLikelyIndependentIssueClause(text = "") {
  return /(不一致|未|没有|不垂直|不顺直|不平整|不规范|不均匀|歪斜|偏位|松动|缺失|裸露|开裂|空鼓|破损|污染|弯折|修补|补槽|堵塞|渗漏|色差|太矮|过矮|太高|过高|过低|太深|过深|不直|倾斜|太紧|过紧|过松|过密|过宽|过窄|太短|过短|太长|过长|太小|过小)/.test(text);
}

function extractIndependentIssueClauses(text = "") {
  const rawClauses = `${text}`
    .split(/[，,；;。！？\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (rawClauses.length <= 1) {
    return rawClauses.map(normalizeIssueClauseText).filter(Boolean);
  }

  const supplementStarts = /^(部分|局部|其中|尤其|导致|造成|表现为)/;

  const merged = [];
  rawClauses.forEach((rawClause) => {
    const clause = normalizeIssueClauseText(rawClause);
    if (!clause) {
      return;
    }
    const isSupplement = supplementStarts.test(rawClause) && !isLikelyIndependentIssueClause(clause);
    if (isSupplement && merged.length) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}，${clause}`;
      return;
    }
    merged.push(clause);
  });

  return merged;
}

function buildDraftBackedIssueItem(draft, itemIndex, sourceIndex, subIssueIndex, overrides = {}) {
  const skipImageRecognition = shouldSkipImageRecognitionForDraft(draft);
  return {
    sourceIndex,
    subIssueIndex,
    area: overrides.area || `现场问题 ${itemIndex + 1}`,
    category: overrides.category || "施工",
    severity: ["critical", "major", "normal"].includes(overrides.severity) ? overrides.severity : ((draft.annotations || []).length ? "major" : "normal"),
    responsibleParty: overrides.responsibleParty || "pending",
    description: resolveIssueDescription(overrides.description, draft, itemIndex),
    suggestion: overrides.suggestion || "请结合现场实际情况整改后复检。",
    visualEvidence: overrides.visualEvidence || (skipImageRecognition
      ? "已根据现场语音转写内容整理。"
      : ((draft.annotations || []).length
        ? "已参考问题照片中的标注位置与局部外观。"
        : "已参考问题照片中的外观特征。")),
    evidenceSource: overrides.evidenceSource || (skipImageRecognition ? "note" : "image"),
    images: skipImageRecognition ? [] : (draft.imagePath ? [draft.imagePath] : []),
    annotatedImages: draft.annotatedImagePath
      ? (skipImageRecognition ? [] : [draft.annotatedImagePath])
      : draft.imagePath && (draft.annotations || []).length
        ? (skipImageRecognition ? [] : [draft.imagePath])
        : [],
    annotations: Array.isArray(draft.annotations) ? draft.annotations : [],
    voiceText: draft.voiceText || "",
    voiceStorageFileId: draft.voiceStorageFileId || draft.voiceFileId || "",
    voiceFilePath: draft.voiceFilePath || "",
    voiceFileId: draft.voiceStorageFileId || draft.voiceFileId || ""
  };
}

function isGenericFallbackDescription(description = "", sourceIndex = 0) {
  const normalized = `${description || ""}`.trim();
  return normalized === `第 ${sourceIndex + 1} 张照片存在待确认问题，请结合照片和标注复核。`;
}

function isLowConfidenceSourceItems(sourceItems = [], sourceIndex = 0) {
  if (!sourceItems.length) {
    return true;
  }
  return sourceItems.every((item) => {
    const genericCategory = GENERIC_CATEGORY_NAMES.includes(item.category || "");
    const genericArea = GENERIC_AREA_NAMES.includes(item.area || "") || `${item.area || ""}`.startsWith("现场问题 ");
    const pendingResponsibleParty = (item.responsibleParty || "") === "pending";
    const genericDescription = isGenericFallbackDescription(item.description, sourceIndex);
    return genericDescription || (genericCategory && genericArea && pendingResponsibleParty);
  });
}

function ensureVoiceIssueCoverage(payload, normalizedItems = []) {
  const drafts = payload.issueDrafts || [];
  const nextItems = [];

  drafts.forEach((draft, sourceIndex) => {
    const sourceItems = normalizedItems
      .filter((item) => item.sourceIndex === sourceIndex)
      .sort((left, right) => (left.subIssueIndex || 1) - (right.subIssueIndex || 1));

    const clauses = extractIndependentIssueClauses(draft.voiceText || "");
    if (!clauses.length) {
      nextItems.push(...sourceItems);
      return;
    }

    if (sourceItems.length >= clauses.length) {
      nextItems.push(...sourceItems);
      return;
    }

    clauses.forEach((clause, clauseIndex) => {
      const current = sourceItems[clauseIndex];
      if (current) {
        nextItems.push({
          ...current,
          subIssueIndex: clauseIndex + 1,
          description: current.description || polishVoiceDescriptionText(clause)
        });
        return;
      }

      const seed = sourceItems[0] || {};
      nextItems.push(buildDraftBackedIssueItem(draft, sourceIndex, sourceIndex, clauseIndex + 1, {
        area: seed.area,
        category: seed.category,
        severity: seed.severity,
        responsibleParty: seed.responsibleParty,
        description: clause,
        suggestion: seed.suggestion || "请针对该子问题分别整改并复检。",
        visualEvidence: seed.visualEvidence,
        evidenceSource: seed.evidenceSource
      }));
    });
  });

  normalizedItems
    .filter((item) => !Number.isInteger(item.sourceIndex) || item.sourceIndex >= drafts.length)
    .forEach((item) => nextItems.push(item));

  return nextItems.sort((left, right) => {
    if (left.sourceIndex !== right.sourceIndex) {
      return left.sourceIndex - right.sourceIndex;
    }
    return (left.subIssueIndex || 1) - (right.subIssueIndex || 1);
  });
}

function buildInspectionItems(payload) {
  const drafts = payload.issueDrafts || [];

  if (drafts.length) {
    return drafts.map((draft, index) => {
      const skipImageRecognition = shouldSkipImageRecognitionForDraft(draft);
      const text = `${draft.voiceText || ""}${payload.note || ""}`;
      let area = `现场问题 ${index + 1}`;
      let category = "施工";
      let severity = draft.annotations && draft.annotations.length ? "major" : "normal";
      let suggestion = "复核施工细节并按现场实际情况整改后复检。";

      if (text.includes("吊顶")) {
        area = "客厅吊顶";
        category = "木作";
        severity = "major";
        suggestion = "校正龙骨标高并重新找平收口。";
      } else if (text.includes("墙砖") || text.includes("瓷砖")) {
        area = "卫生间墙砖";
        category = "泥工";
        severity = "critical";
        suggestion = "检查空鼓与缝宽，必要时拆除重铺。";
      } else if (text.includes("柜") || text.includes("柜体")) {
        area = "柜体安装";
        category = "木作";
        severity = "normal";
        suggestion = "调整柜门缝隙和五金，复核安装垂直度。";
      }

      return {
        sourceIndex: index,
        subIssueIndex: 1,
        area,
        category,
        severity,
        responsibleParty: "constructor",
        description: resolveIssueDescription("", draft, index),
        suggestion,
        visualEvidence: skipImageRecognition
          ? "已根据现场语音转写内容整理。"
          : (draft.annotations && draft.annotations.length
            ? "已参考问题照片中的标注位置与局部外观。"
            : "已参考问题照片中的外观特征。"),
        evidenceSource: skipImageRecognition ? "note" : "image",
        images: skipImageRecognition ? [] : [draft.imagePath],
        annotatedImages: skipImageRecognition ? [] : (draft.annotations && draft.annotations.length ? [draft.imagePath] : []),
        annotations: draft.annotations || [],
        voiceText: draft.voiceText || "",
        voiceStorageFileId: draft.voiceStorageFileId || draft.voiceFileId || "",
        voiceFilePath: draft.voiceFilePath || "",
        voiceFileId: draft.voiceStorageFileId || draft.voiceFileId || ""
      };
    });
  }

  const images = payload.images || [];
  return [
    {
      sourceIndex: 0,
      subIssueIndex: 1,
      area: "客厅吊顶",
      category: "木作",
      severity: images.length > 2 ? "major" : "normal",
      responsibleParty: "constructor",
      description: "吊顶转角收口不顺直，局部存在高低差。",
      suggestion: "复核龙骨标高并重新找平，确保收口顺直。",
      visualEvidence: "已参考巡查照片中的吊顶转角与收口外观。",
      evidenceSource: "image",
      images,
      annotatedImages: [],
      annotations: [],
      voiceText: "",
      voiceStorageFileId: "",
      voiceFilePath: "",
      voiceFileId: ""
    }
  ];
}

function buildInspectionSummary(payload, items) {
  const total = items.length;
  const categoryMap = {};
  const severityMap = {
    critical: 0,
    major: 0,
    normal: 0
  };

  items.forEach((item) => {
    if (item.category) {
      categoryMap[item.category] = (categoryMap[item.category] || 0) + 1;
    }
    if (severityMap[item.severity] !== undefined) {
      severityMap[item.severity] += 1;
    }
  });

  const topCategories = Object.entries(categoryMap)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([name, count]) => `${name}${count}项`);

  const highlightParts = [
    `本次巡查共整理出 ${total} 个问题项`
  ];

  if (topCategories.length) {
    highlightParts.push(`主要集中在${topCategories.join("、")}`);
  }

  if (severityMap.critical) {
    highlightParts.push(`其中 ${severityMap.critical} 项需优先整改`);
  } else if (severityMap.major) {
    highlightParts.push(`建议优先处理较重问题`);
  }

  if (payload.note) {
    highlightParts.push(`已结合现场补充信息进行归纳`);
  }

  return `${highlightParts.join("，")}。`;
}

function buildIssueDraftContext(payload) {
  return (payload.issueDrafts || []).map((draft, index) => ({
    index,
    note: draft.voiceText || "",
    annotationText: formatAnnotations(draft.annotations || []),
    annotationsCount: (draft.annotations || []).length,
    hasImage: Boolean(draft.imagePath),
    imagePath: draft.imagePath || ""
  }));
}

function chunkArray(list = [], size = 1) {
  const result = [];
  const normalizedSize = Math.max(1, size);
  for (let index = 0; index < list.length; index += normalizedSize) {
    result.push(list.slice(index, index + normalizedSize));
  }
  return result;
}

function createBatchPayload(payload, draftIndexes = []) {
  const sourceDrafts = payload.issueDrafts || [];
  const issueDrafts = draftIndexes.map((index) => sourceDrafts[index]).filter(Boolean);
  return Object.assign({}, payload, {
    issueDrafts,
    images: issueDrafts.map((draft) => draft.imagePath).filter(Boolean)
  });
}

async function runWithConcurrency(taskFactories = [], limit = 1) {
  const results = new Array(taskFactories.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, taskFactories.length || 1));

  async function worker() {
    while (nextIndex < taskFactories.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await taskFactories[currentIndex]();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function getNormalizedSourceIndex(drafts = [], item = {}, index = 0) {
  return Number.isInteger(item.sourceIndex)
    ? Math.max(0, Math.min(item.sourceIndex, Math.max(drafts.length - 1, 0)))
    : Math.min(index, Math.max(drafts.length - 1, 0));
}

function normalizeInspectionAiItems(payload, parsedItems = [], options = {}) {
  const drafts = payload.issueDrafts || [];
  const normalized = [];
  const fillMissingDrafts = options.fillMissingDrafts !== false;

  parsedItems.forEach((item, index) => {
    const fallbackDraft = drafts[index] || {};
    const normalizedSourceIndex = getNormalizedSourceIndex(drafts, item, index);
    const sourceIndex = normalizedSourceIndex;
    const sourceDraft = drafts[sourceIndex] || fallbackDraft || {};

    normalized.push(buildDraftBackedIssueItem(
      sourceDraft,
      index,
      normalizedSourceIndex,
      Number.isInteger(item.subIssueIndex) && item.subIssueIndex > 0 ? item.subIssueIndex : 1,
      {
        area: item.area,
        category: item.category,
        severity: ["critical", "major", "normal"].includes(item.severity) ? item.severity : "normal",
        responsibleParty: item.responsibleParty || "pending",
        description: item.description,
        suggestion: item.suggestion,
        visualEvidence: item.visualEvidence,
        evidenceSource: item.evidenceSource
      }
    ));
  });

  if (fillMissingDrafts) {
    const covered = new Set(normalized.map((item) => item.sourceIndex));
    drafts.forEach((draft, index) => {
      if (covered.has(index)) {
        return;
      }
      normalized.push(buildDraftBackedIssueItem(draft, index, index, 1));
    });
  }

  return ensureVoiceIssueCoverage(payload, normalized).sort((left, right) => {
    if (left.sourceIndex !== right.sourceIndex) {
      return left.sourceIndex - right.sourceIndex;
    }
    return (left.subIssueIndex || 1) - (right.subIssueIndex || 1);
  });
}

function formatAnnotations(annotations = []) {
  return annotations.map((item, index) => {
    const type = item.type || "mark";
    const start = item.start || {};
    const end = item.end || {};
    return `${index + 1}. ${type} 起点(${Math.round(start.x || 0)},${Math.round(start.y || 0)}) 终点(${Math.round(end.x || 0)},${Math.round(end.y || 0)})`;
  }).join("\n");
}

/** 从云存储 fileID 中取出路径部分 */
function extractCloudPath(fileID) {
  const matched = /^cloud:\/\/[^/]+\/(.+)$/.exec(`${fileID || ""}`);
  return matched ? matched[1] : "";
}

/** 校验 fileID 是否落在该用户自己的目录下 */
function isFileOwnedByOpenId(fileID, openId) {
  if (!fileID || !openId) {
    return false;
  }
  return extractCloudPath(fileID).includes(`/user/${openId}/`);
}

/**
 * 把云存储 fileID 换成可直接交给模型的临时链接。
 *
 * 原实现不校验归属：只要在草稿里塞入别人的 cloud:// fileID，
 * 云端就会签发临时链接并把它送给第三方大模型，等于代读他人照片。
 * 因此这里要求图片必须位于调用者自己的 user/{openId}/ 目录下。
 * 归属不符时返回空字符串，让该草稿按「无图」继续处理，不中断整批分析。
 */
async function resolveImageUrl(filePath, openId) {
  if (!filePath) {
    return "";
  }

  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    return filePath;
  }

  if (filePath.startsWith("cloud://")) {
    if (!isFileOwnedByOpenId(filePath, openId)) {
      console.warn("[ai] 跳过不属于当前用户的图片", {
        cloudPath: extractCloudPath(filePath) || "(无法解析)"
      });
      return "";
    }

    const result = await cloud.getTempFileURL({
      fileList: [filePath]
    });
    const file = (result.fileList || [])[0] || {};
    return file.tempFileURL || "";
  }

  return filePath;
}

async function buildMultimodalMessages(payload) {
  const draftContexts = await Promise.all((payload.issueDrafts || []).map(async (draft, index) => ({
    index,
    useImage: !shouldSkipImageRecognitionForDraft(draft),
    imageUrl: shouldSkipImageRecognitionForDraft(draft) ? "" : await resolveImageUrl(draft.imagePath, payload.requesterOpenId),
    note: draft.voiceText || "",
    annotationText: formatAnnotations(draft.annotations || [])
  })));

  const userContent = [
    {
      type: "text",
      text: getInspectionAiUserInstructionLines(payload).join("\n")
    }
  ];

  draftContexts.forEach((draft) => {
    userContent.push({
      type: "text",
      text: [
        `问题草稿 ${draft.index + 1}`,
        `现场备注：${draft.note || "无"}`,
        `标注信息：${draft.annotationText || "无"}`,
        draft.useImage
          ? "请判断这张照片里有哪些可独立成立、独立核验、独立整改的缺陷点；这些点默认拆成多个子问题，并使用相同 sourceIndex + 递增 subIssueIndex。"
          : "该草稿已有明确语音转写，请直接基于文字整理问题点，不要再依赖图片识别；这些点默认拆成多个子问题，并使用相同 sourceIndex + 递增 subIssueIndex。"
      ].join("\n")
    });
    if (draft.useImage && draft.imageUrl) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: draft.imageUrl
        }
      });
    }
  });

  return [
    {
      role: "system",
      content: getInspectionAiSystemPrompt()
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

async function analyzeInspectionWithOpenAiCompatible(payload) {
  const runtimeConfig = getAiRuntimeConfig();
  const requestBody = {
    model: runtimeConfig.model,
    temperature: 0.2,
    response_format: {
      type: "json_object"
    },
    messages: await buildMultimodalMessages(payload)
  };

  if (runtimeConfig.provider === "zhipu" || runtimeConfig.model.startsWith("glm-4.6v")) {
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
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  return {
    items: normalizeInspectionAiItems(payload, items),
    summary: parsed.summary || ""
  };
}

async function analyzeSingleDraftWithOpenAiCompatible(payload, draft, originalIndex) {
  const singlePayload = Object.assign({}, payload, {
    issueDrafts: [draft],
    images: draft.imagePath ? [draft.imagePath] : []
  });
  const requestBody = {
    model: getAiRuntimeConfig().model,
    temperature: 0.2,
    response_format: {
      type: "json_object"
    },
    messages: await buildMultimodalMessages(singlePayload)
  };

  const runtimeConfig = getAiRuntimeConfig();
  if (runtimeConfig.provider === "zhipu" || runtimeConfig.model.startsWith("glm-4.6v")) {
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
  const items = normalizeInspectionAiItems(singlePayload, Array.isArray(parsed.items) ? parsed.items : [], {
    fillMissingDrafts: false
  }).map((item) => ({
    ...item,
    sourceIndex: originalIndex
  }));

  return items;
}

async function analyzeDraftBatchWithOpenAiCompatible(payload, draftIndexes = []) {
  const batchPayload = createBatchPayload(payload, draftIndexes);
  const batchResult = await analyzeInspectionWithOpenAiCompatible(batchPayload);
  const batchItems = (batchResult.items || []).map((item) => ({
    ...item,
    sourceIndex: draftIndexes[item.sourceIndex] !== undefined ? draftIndexes[item.sourceIndex] : draftIndexes[0] || 0
  }));
  const covered = new Set(batchItems.map((item) => item.sourceIndex));
  const missingDraftIndexes = draftIndexes.filter((index) => !covered.has(index));

  if (!missingDraftIndexes.length) {
    return batchItems;
  }

  const supplementedGroups = await Promise.all(missingDraftIndexes.map(async (index) => {
    const draft = (payload.issueDrafts || [])[index];
    try {
      return await analyzeSingleDraftWithOpenAiCompatible(payload, draft, index);
    } catch (error) {
      console.error("analyzeSingleDraftWithOpenAiCompatible failed", {
        index,
        error
      });
      return [buildDraftBackedIssueItem(draft, index, index, 1)];
    }
  }));

  return [...batchItems, ...supplementedGroups.flat()];
}

async function analyzeInspectionBatch(payload, draftIndexes = []) {
  const batchPayload = createBatchPayload(payload, draftIndexes);
  const runtimeConfig = getAiRuntimeConfig();
  if (isOpenAiCompatibleEnabled(runtimeConfig)) {
    return analyzeDraftBatchWithOpenAiCompatible(payload, draftIndexes);
  }
  const batchResult = await analyzeInspectionWithModel(batchPayload);
  return (batchResult.items || []).map((item) => ({
    ...item,
    sourceIndex: draftIndexes[item.sourceIndex] !== undefined ? draftIndexes[item.sourceIndex] : draftIndexes[0] || 0
  }));
}

async function finalizeTaskItems(payload, mergedItems = []) {
  const normalizedItems = normalizeInspectionAiItems(payload, mergedItems, {
    fillMissingDrafts: true
  });
  const drafts = payload.issueDrafts || [];
  const sourceIndexesToRetry = drafts
    .map((_, index) => index)
    .filter((sourceIndex) => {
      const sourceItems = normalizedItems.filter((item) => item.sourceIndex === sourceIndex);
      return isLowConfidenceSourceItems(sourceItems, sourceIndex);
    });

  if (!sourceIndexesToRetry.length) {
    return normalizedItems;
  }

  const retriedGroups = await Promise.all(sourceIndexesToRetry.map(async (sourceIndex) => {
    const draft = drafts[sourceIndex];
    try {
      return await analyzeSingleDraftWithOpenAiCompatible(payload, draft, sourceIndex);
    } catch (error) {
      console.error("finalizeTaskItems retry failed", {
        sourceIndex,
        error
      });
      return normalizedItems.filter((item) => item.sourceIndex === sourceIndex);
    }
  }));

  const retriedMap = new Map();
  sourceIndexesToRetry.forEach((sourceIndex, index) => {
    retriedMap.set(sourceIndex, retriedGroups[index] || []);
  });

  const replacedItems = normalizedItems.filter((item) => !retriedMap.has(item.sourceIndex));
  retriedMap.forEach((items) => {
    replacedItems.push(...items);
  });

  return normalizeInspectionAiItems(payload, replacedItems, {
    fillMissingDrafts: true
  });
}

function buildTaskDraftIndexes(payload = {}) {
  return (payload.issueDrafts || []).map((_, index) => index);
}

function buildAiTaskStatus(task = {}, analysis = null) {
  return {
    taskId: task._id || "",
    status: task.status || "queued",
    totalBatches: task.totalBatches || 0,
    completedBatches: task.completedBatches || 0,
    currentBatchIndex: task.currentBatchIndex || 0,
    errorMessage: task.errorMessage || "",
    analysis
  };
}

async function createAnalysisTask(payload, openId) {
  const enhancedPayload = await enrichPayloadWithMemory(payload);
  const draftIndexes = buildTaskDraftIndexes(enhancedPayload);
  const batches = chunkArray(draftIndexes, AI_BATCH_SIZE);
  const now = Date.now();
  const created = await db.collection(AI_TASK_COLLECTION).add({
    data: {
      status: "queued",
      // 记录归属：getInspectionTaskStatus 据此校验调用者，
      // 避免只要猜到 taskId 就能读到他人的问题描述、图片路径与语音文本
      openId,
      projectId: enhancedPayload.projectId || "",
      payload: enhancedPayload,
      batches,
      partialItems: [],
      totalBatches: batches.length,
      completedBatches: 0,
      currentBatchIndex: 0,
      errorMessage: "",
      createdAt: now,
      expiresAt: now + AI_TASK_TTL_MS,
      updatedAt: now
    }
  });
  const task = await db.collection(AI_TASK_COLLECTION).doc(created._id).get();
  return task.data;
}

async function processAnalysisTask(task) {
  if (!task || task.status === "success" || task.status === "failed") {
    return task;
  }
  const payload = task.payload || {};
  const batches = task.batches || [];
  const currentBatchIndex = task.currentBatchIndex || 0;
  if (!batches.length) {
    const analysis = {
      items: [],
      summary: buildInspectionSummary(payload, []),
      aiMode: "fallback",
      memoryHint: payload.memoryHint || "",
      memoryAlerts: []
    };
    await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
      data: {
        status: "success",
        analysis,
        updatedAt: Date.now()
      }
    });
    const refreshed = await db.collection(AI_TASK_COLLECTION).doc(task._id).get();
    return refreshed.data;
  }

  if (currentBatchIndex >= batches.length) {
    return task;
  }

  await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
    data: {
      status: "running",
      updatedAt: Date.now()
    }
  });

  try {
    const batchIndexes = batches[currentBatchIndex] || [];
    const batchItems = await analyzeInspectionBatch(payload, batchIndexes);
    const mergedItems = (task.partialItems || []).concat(batchItems || []);
    const completedBatches = currentBatchIndex + 1;
    const updateData = {
      completedBatches,
      currentBatchIndex: completedBatches,
      updatedAt: Date.now()
    };
    if (completedBatches >= batches.length) {
      const finalItems = await finalizeTaskItems(payload, mergedItems);
      const finalAnalysis = {
        items: finalItems,
        summary: buildInspectionSummary(payload, finalItems),
        aiMode: "model",
        memoryHint: payload.memoryHint || "",
        memoryAlerts: buildMemoryAlerts(payload, finalItems)
      };
      updateData.status = "success";
      updateData.payload = _.remove();
      updateData.batches = _.remove();
      updateData.partialItems = _.remove();
      await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
        data: updateData
      });
      const refreshed = await db.collection(AI_TASK_COLLECTION).doc(task._id).get();
      return Object.assign({}, refreshed.data, {
        runtimeAnalysis: finalAnalysis
      });
    } else {
      updateData.status = "running";
      updateData.partialItems = mergedItems;
    }
    await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
      data: updateData
    });
  } catch (error) {
    console.error("processAnalysisTask failed", error);
    await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
      data: {
        status: "failed",
        errorMessage: error && error.message ? error.message : "AI 分析失败",
        updatedAt: Date.now()
      }
    });
  }

  const refreshed = await db.collection(AI_TASK_COLLECTION).doc(task._id).get();
  return refreshed.data;
}

async function getAnalysisTask(taskId) {
  // 文档不存在时 SDK 会抛错，这里收敛成 null，
  // 由调用方决定返回「任务不存在」还是「无权访问」。
  try {
    const task = await db.collection(AI_TASK_COLLECTION).doc(taskId).get();
    return task.data || null;
  } catch (error) {
    return null;
  }
}

async function analyzeInspectionWithModel(payload) {
  const runtimeConfig = getAiRuntimeConfig();
  if (isOpenAiCompatibleEnabled(runtimeConfig)) {
    const drafts = payload.issueDrafts || [];
    if (drafts.length > 5) {
      const draftIndexes = drafts.map((_, index) => index);
      const batches = chunkArray(draftIndexes, AI_BATCH_SIZE);
      const batchResults = await runWithConcurrency(
        batches.map((batchIndexes) => async () => analyzeDraftBatchWithOpenAiCompatible(payload, batchIndexes)),
        AI_BATCH_PARALLEL_LIMIT
      );
      const mergedItems = batchResults.flat();
      return {
        items: normalizeInspectionAiItems(payload, mergedItems, {
          fillMissingDrafts: true
        }),
        summary: ""
      };
    }

    const modelResult = await analyzeInspectionWithOpenAiCompatible(payload);
    const covered = new Set((modelResult.items || []).map((item) => item.sourceIndex));
    const missingDraftIndexes = drafts
      .map((_, index) => index)
      .filter((index) => !covered.has(index));

    if (missingDraftIndexes.length) {
      const supplementedGroups = await Promise.all(missingDraftIndexes.map(async (index) => {
        const draft = drafts[index];
        try {
          return await analyzeSingleDraftWithOpenAiCompatible(payload, draft, index);
        } catch (error) {
          console.error("analyzeSingleDraftWithOpenAiCompatible failed", {
            index,
            error
          });
          return [buildDraftBackedIssueItem(draft, index, index, 1)];
        }
      }));

      const supplementedItems = supplementedGroups.flat();
      const mergedItems = [...(modelResult.items || [])];
      const mergedCovered = new Set(mergedItems.map((item) => item.sourceIndex));

      supplementedItems.forEach((item) => {
        if (!mergedCovered.has(item.sourceIndex)) {
          mergedItems.push(item);
          mergedCovered.add(item.sourceIndex);
        } else if ((item.subIssueIndex || 1) > 1) {
          mergedItems.push(item);
        }
      });

      return {
        ...modelResult,
        items: normalizeInspectionAiItems(payload, mergedItems, {
          fillMissingDrafts: true
        })
      };
    }

    return modelResult;
  }

  const client = getHunyuanClient();
  const userPrompt = [
    ...getInspectionAiUserInstructionLines(payload),
    `问题草稿：${JSON.stringify(buildIssueDraftContext(payload))}`
  ].join("\n");

  const response = await client.ChatCompletions({
    Model: runtimeConfig.model,
    Stream: false,
    Temperature: 0.2,
    Messages: [
      {
        Role: "system",
        Content: getInspectionAiSystemPrompt()
      },
      {
        Role: "user",
        Content: userPrompt
      }
    ]
  });

  const text = extractAssistantText(response);
  const parsed = safeJsonParse(text);
  const items = Array.isArray(parsed.items) ? parsed.items : [];

  return {
    items: normalizeInspectionAiItems(payload, items).map((item) => {
      const sourceDraft = (payload.issueDrafts || [])[item.sourceIndex] || {};
      return {
        ...item,
        images: item.images && item.images.length ? item.images : sourceDraft.imagePath ? [sourceDraft.imagePath] : [],
        annotatedImages: item.annotatedImages && item.annotatedImages.length
          ? item.annotatedImages
          : sourceDraft.annotatedImagePath
            ? [sourceDraft.annotatedImagePath]
            : sourceDraft.imagePath && (sourceDraft.annotations || []).length
              ? [sourceDraft.imagePath]
              : []
      };
    }),
    summary: parsed.summary || ""
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    switch (action) {
      case "analyzeInspection": {
        const access = await assertProjectAccess(payload.projectId, OPENID);
        if (!access.ok) {
          return { success: false, message: access.message };
        }

        // 带上调用者身份：图片归属校验需要它（见 resolveImageUrl）。
        // 草稿里的 imagePath 来自客户端，不能仅凭项目归属就假定图片也是本人的。
        const securedPayload = Object.assign({}, payload, { requesterOpenId: OPENID });
        const enhancedPayload = await enrichPayloadWithMemory(securedPayload);
        try {
          const modelResult = await analyzeInspectionWithModel(enhancedPayload);
          const memoryAlerts = buildMemoryAlerts(enhancedPayload, modelResult.items);
          return {
            success: true,
            data: {
              items: modelResult.items,
              summary: modelResult.summary || buildInspectionSummary(enhancedPayload, modelResult.items),
              aiMode: "model",
              memoryHint: enhancedPayload.memoryHint || "",
              memoryAlerts
            }
          };
        } catch (error) {
          console.error("analyzeInspectionWithModel failed", error);
        }

        const items = buildInspectionItems(enhancedPayload);
        const memoryAlerts = buildMemoryAlerts(enhancedPayload, items);
        return {
          success: true,
          data: {
            items,
            summary: buildInspectionSummary(enhancedPayload, items),
            aiMode: "fallback",
            memoryHint: enhancedPayload.memoryHint || "",
            memoryAlerts
          }
        };
      }

      case "createInspectionTask": {
        const access = await assertProjectAccess(payload.projectId, OPENID);
        if (!access.ok) {
          return { success: false, message: access.message };
        }

        const task = await createAnalysisTask(
          Object.assign({}, payload, { requesterOpenId: OPENID }),
          OPENID
        );
        return {
          success: true,
          data: buildAiTaskStatus(task)
        };
      }

      case "getInspectionTaskStatus": {
        if (!payload.taskId) {
          return {
            success: false,
            message: "缺少任务ID"
          };
        }

        let task = await getAnalysisTask(payload.taskId);
        if (!task) {
          return {
            success: false,
            message: "AI 分析任务不存在"
          };
        }

        // 任务只对创建者本人可见。
        // 历史任务没有 openId 字段，一律拒绝，避免留下一条越权读取通道。
        if (!task.openId || task.openId !== OPENID) {
          return {
            success: false,
            message: "无权访问该任务"
          };
        }

        if (task.status === "queued" || task.status === "running") {
          task = await processAnalysisTask(task);
        }
        return {
          success: true,
          data: buildAiTaskStatus(task, task.runtimeAnalysis || null)
        };
      }

      default:
        return {
          success: false,
          message: "未知操作"
        };
    }
  } catch (error) {
    console.error("[ai] action failed", {
      action,
      message: error && error.message,
      stack: error && error.stack
    });
    return {
      success: false,
      message: (error && error.message) || "AI 服务异常，请稍后重试"
    };
  }
};
