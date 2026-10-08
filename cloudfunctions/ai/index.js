const cloud = require("wx-server-sdk");
const {hash,requestKey,reserve,assertMedia} = require("./reliable");
const tencentcloud = require("tencentcloud-sdk-nodejs");
const axios = require("axios");
const { wantsTextOrganization, textMessages, normalizeTextItems, extractExplicitField } = require('./text-organizer');

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
const AI_BATCH_SIZE = 1;
// One photo per request keeps source mapping and retries precise. The small,
// configurable concurrency cap controls latency without turning a 20-photo
// submission into a single oversized model request.
// Keep the hard ceiling at three requests. A deployment may lower the limit
// for quota or provider pressure, but must not raise it into an unbounded
// fan-out for a 20-photo field record.
const AI_BATCH_PARALLEL_LIMIT = Math.min(3, Math.max(1, Number(process.env.AI_BATCH_PARALLEL_LIMIT || 3)));

/**
 * AI 任务记录的保留时长。
 * 任务里带着完整的草稿载荷（图片路径、语音文本），失败或被用户放弃的任务
 * 原先会永久堆积，既占存储也留着数据。这里给一个 7 天 TTL 便于定期清理。
 */
const AI_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 异步任务每次调用处理批次的时间预算。
 * 留足余量给最终写入与响应——云函数上限是 60 秒，这里给 45 秒。
 */
const AI_TASK_TIME_BUDGET_MS = 45 * 1000;
// Each compatible-model request may occupy 30s. Reserve that full timeout
// plus a small checkpoint/finalization margin before starting an automatic
// retry; otherwise a late first failure can push the invocation past its own
// 45s task budget (and the cloud-function hard timeout) before it records the
// failure or releases the task lease.
const AI_TASK_AUTOMATIC_RETRY_RESERVE_MS = 35 * 1000;

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
  if (draft.skipImageRecognition === true || !draft.imagePath) return true;
  if (draft.analysisMode === "ai") return false;
  if (["manual", "pending"].includes(draft.analysisMode)) return true;
  // Backward-compatible default: a successful transcription or typed field
  // statement is already the inspector's conclusion. Do not spend time and
  // quota guessing the same photo unless the user explicitly chooses AI.
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
    thinkingEnabled: (process.env.AI_THINKING || "").toLowerCase() === "enabled",
    /**
     * 图片精细度。
     *
     * 巡检照片需要尽量保留边缘、接缝和表面状态；但这里只做可见证据定位，
     * 不把像素观感当成真实尺寸测量。多数多模态接口默认会降采样，因此请求 high。
     * 设成空字符串则不发送该字段，兼容不支持 detail 的服务商。
     */
    imageDetail: process.env.AI_IMAGE_DETAIL === undefined
      ? "high"
      : process.env.AI_IMAGE_DETAIL
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
        endpoint: "hunyuan.tencentcloudapi.com",
        // Tencent SDK reqTimeout is in seconds; fit one request inside the advance budget.
        reqTimeout: 30
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

function hasDraftsRequiringVision(payload = {}) {
  return (payload.issueDrafts || []).some((draft) => !shouldSkipImageRecognitionForDraft(draft));
}

function assertVisionRuntimeAvailable(payload, runtimeConfig) {
  if (hasDraftsRequiringVision(payload) && !isOpenAiCompatibleEnabled(runtimeConfig)) {
    throw new Error(
      "当前 AI 云函数未配置支持图片分析的模型。照片已保留，可稍后重试或直接进入人工核对"
    );
  }
}

function buildSafeRuntimeStatus() {
  const runtimeConfig = getAiRuntimeConfig();
  const openAiCompatible = isOpenAiCompatibleEnabled(runtimeConfig);
  const textFallbackConfigured = Boolean(runtimeConfig.secretId && runtimeConfig.secretKey);
  return {
    provider: openAiCompatible
      ? (runtimeConfig.provider || "openai-compatible")
      : (textFallbackConfigured ? "tencent-hunyuan-text" : "unconfigured"),
    model: runtimeConfig.model,
    visionEnabled: openAiCompatible,
    imageDetail: runtimeConfig.imageDetail || "provider-default",
    batchSize: AI_BATCH_SIZE,
    parallelLimit: AI_BATCH_PARALLEL_LIMIT,
    maxPhotos: 20
  };
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
    inspectionId: _.in(inspectionIds)
  }).get();
  return (result.data || []).filter((item) => item.deleted !== true);
}

async function buildUserPreferenceMemory(openId) {
  if (!openId) {
    return {
      applied: false,
      lines: []
    };
  }

  try {
    const inspectionsResult = await db.collection("inspections").where({
      inspectorOpenId: openId
    }).orderBy("createdAt", "desc").limit(8).get();
    const inspectionList = (inspectionsResult.data || []).filter((item) => item.deleted !== true);
    const inspectionIds = inspectionList.map((item) => item._id).filter(Boolean);
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
    const inspectionsResult = await db.collection("inspections").where({
      projectId
    }).orderBy("createdAt", "desc").limit(3).get();
    const inspectionList = (inspectionsResult.data || []).filter((item) => item.deleted !== true);
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
    observations: [{ sourceIndex: 0, text: "照片中可直接辨认的客观外观；不作质量结论" }],
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
        confidence: "high|medium|low",
        needsReview: true,
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
    "你是装修巡查问题结构化整理引擎，不是聊天助手。你的输出将用于现场巡查结果人工确认和在线报告分组。",
    "",
    "你的任务分为五层：",
    "1. 以每张现场照片为独立分析单元，绝不跨照片合并问题。",
    "2. 判断同一张照片里的现场补充、语音转写文字和标注信息，描述的是一个问题的多个细节，还是多个独立问题。",
    "3. 同一张照片里，只要某个细节可以独立成立、独立核验、独立整改，就应拆成 1 条独立子问题。",
    "4. 如果是同一张照片里的多个独立问题，拆成多条问题项；这些问题项必须共享同一个 sourceIndex，并按 1 开始递增 subIssueIndex。",
    "5. 只有当多句描述明显只是同一个问题的补充说明、后果描述或同义复述时，才允许合并为 1 条子问题。",
    "6. 如果某张照片没有任何语音或文字输入，只根据照片中有证据支持的现象整理；没有可确认问题时输出空数组，不编造问题。",
    "7. 每条问题项都要补足结构化字段，并输出 summary。",
    "8. 语音、文字与历史记录只用于补充定位和语义；不能代替当前照片证据，也不能把历史问题套到当前照片。",
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
    "- 在内部先判断照片所处施工阶段，再按构件检查异常：瓷砖与美缝看崩边、接缝空缺、明显不连续；木作看破损、拼缝错位与收口缺口；墙顶看裂缝、起皮与明显边界破损；安装构件看可见破损、松脱和缺件。只输出照片确实支持的具体问题，不罗列检查清单。",
    "- 示例：仅看到‘瓷砖地面与灰色美缝’不是问题，items 为空；若清楚看到‘第三排砖缝局部断开，缝内存在空缺’，才写成问题。不能把颜色、材质、物体数量或施工阶段的介绍包装成问题。不得凭照片推断不可测的平整度、强度或规范合格与否。",
    "- 面向装修现场巡查，不做通用图片介绍：逐项检查构件边缘、接缝、表面及安装位置，仅将清楚可见的异常写成问题。description 只写具体位置与看到的问题，不提供处理建议、整改方案或泛泛评价。",
    "- 正例：‘门洞右侧收口边缘存在连续缺口，局部基层外露。’‘木饰面板拼接处上下边缘错位。’反例：‘画面中有门洞和墙面。’‘建议重新修补。’不能凭裸露基层或施工未完成状态认定缺陷。",
    "- AI 识图的首要任务是判断可见质量问题，而不是只描述画面。先检查可见裂缝、破损、拼接错位、收口缺口、污染及明显安装缺陷；有清楚依据时必须写入 items，不能仅放在 observations 后遗漏问题。",
    "- 每个图片问题的 description 按‘具体位置或构件 + 可见异常’表述；不编造测量值、责任结论、隐蔽原因或推测影响。疑似情况标明待现场复核，不把施工未完成本身判为缺陷。不输出处理建议。",
    "- 返回严格 JSON，不要输出 Markdown、解释、注释或额外文字。",
    "- observations 可返回空数组，不需要为了证明识图成功而介绍画面；没有明确问题就返回空 items，不用对象清单填充结果。",
    "- observations 只写看得见的对象、位置或状态，不判断合格与否、不推断缺陷；禁止泛泛写‘已识别/未发现问题/画面正常’。只有照片模糊、严重遮挡或画面确实无法辨认时才允许返回空数组。",
    "- observations 的每项必须包含 sourceIndex 和简短 text；它们只用于人工核对，不是问题，不计入问题数量，也不会直接进入报告。",
    "- items 是扁平数组，但同一张照片的多个问题必须拥有相同 sourceIndex，并使用 subIssueIndex 表示该照片下的第几个子问题。",
    "- 照片允许没有问题项。未识别到问题不等于工程合格，不生成占位缺陷。",
    "- 当某条问题主要依据语音转写整理时，description 必须润色成书面化、可直接用于巡查确认和在线报告的问题描述，不能直接照抄口语原文。",
    "- 需要把“这个、那里、有点、好像、然后、就是”等口语化表达整理成正式巡查表述，并去掉语气词、重复词和填充词。",
    "- visualEvidence 必须写你从图片或标注中真正观察到的证据，不能只复述语音文字。",
    "- 不得从单张照片推断真实尺寸、垂直度、强度、隐蔽层做法或规范结论，除非照片中存在可信量尺、清晰标注或现场文字依据。",
    "- 如果只能确认现场状态、不能确认质量缺陷，则不要生成问题；允许返回空 items。",
    "- confidence 只允许 high / medium / low。high 仅用于证据清楚且描述与可见位置直接对应；有遮挡、尺度不明或仅有口述时使用 medium / low。",
    "- needsReview 在 confidence 为 low、依据主要来自 note、图片与文字冲突或责任方/严重级无法确认时必须为 true。",
    "- 当没有语音转写文字时，仍要根据图片和标注进行判断；没有足够证据时返回空结果，不得为了有输出而编造。",
    "- 若无法确认责任方或等级，可保守输出 pending / normal，但不要编造不存在的证据。",
    "- images、annotatedImages、annotations、voiceText、voiceStorageFileId、voiceFilePath、voiceFileId 由后处理补全；模型无需编造真实文件路径，可返回空数组或空字符串。",
    "- 语音里以肯定语气明确陈述的每个独立缺陷，必须在 items 中保留；‘请查看、是否存在、可能、疑似、待确认’只是检查线索，不能直接转成既定问题。",
    "- 先判断照片展示的是施工过程、成品状态还是无法判断。材料堆放、管线外露、墙面未完成等施工过程状态本身不等于质量缺陷。",
    "- description 必须描述可定位、可复核的现象；建议不得引入照片和现场说明里没有的材料、尺寸、工艺或责任结论。",
    "",
    "错误示例：",
    "- 把语音里明确提到的‘管卡颜色不一致’直接吞掉，只保留另一个问题。",
    "- 把同一张照片里‘线管弯折’和‘插座底盒歪斜’合并成一个问题。",
    "- 只复述语音内容，不写图片证据。",
    "",
    "正确目标：",
    "- 模型输出能直接支持‘一张照片一个一级问题块，右侧多个子问题条目’的报告结构。",
    "- 同图多问题时，sourceIndex 相同，subIssueIndex 为 1/2/3/4。",
    "- 照片上存在‘编号 1、2、3…’区域标记时，subIssueIndex 必须与编号一致；不得交换编号对应的问题。",
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
    "5. 语音中以肯定语气明确说出的独立缺陷点不允许遗漏；检查请求、疑问和不确定描述只作为观察线索。",
    "6. 若没有语音或文字输入，仍要检查照片和标注；没有足够证据时返回空 items。",
    "7. 不做无量尺的尺寸判断，不把施工过程状态自动判为质量缺陷。",
    "8. 照片上有编号区域时，问题顺序必须严格对应编号 1、2、3、4。"
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

function isExplicitIssueAssertion(text = "") {
  const normalized = `${text || ""}`.trim();
  if (!normalized || !isLikelyIndependentIssueClause(normalized)) return false;
  return !/(是否|可能|好像|疑似|似乎|不确定|待确认|判断|核对|请.{0,8}(查看|检查|确认))/.test(normalized);
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

function extractAssertedIssueClauses(text = "") {
  return extractIndependentIssueClauses(text).filter(isExplicitIssueAssertion);
}

function buildDraftBackedIssueItem(draft, itemIndex, sourceIndex, subIssueIndex, overrides = {}) {
  const skipImageRecognition = shouldSkipImageRecognitionForDraft(draft);
  const hasVoiceText = hasMeaningfulVoiceText(draft.voiceText);
  const evidenceSource = ["image", "note", "image+note", "model-only"].includes(overrides.evidenceSource)
    ? overrides.evidenceSource
    : (skipImageRecognition ? "note" : (hasVoiceText ? "image+note" : "image"));
  const confidence = ["high", "medium", "low"].includes(overrides.confidence)
    ? overrides.confidence
    : "low";
  const numberedMarkers = (draft.annotations || []).filter(annotation => annotation.type === "point" || ((annotation.type === "box" || annotation.type === "ellipse") && annotation.numbered === true));
  const numberedMarker = numberedMarkers[Math.max(0, subIssueIndex - 1)] || null;
  return {
    sourceIndex,
    subIssueIndex,
    annotationId: numberedMarker ? numberedMarker.id || "" : "",
    markerNumber: numberedMarker ? subIssueIndex : 0,
    area: overrides.area || "",
    category: overrides.category || "",
    severity: ["critical", "major", "normal"].includes(overrides.severity) ? overrides.severity : "normal",
    responsibleParty: overrides.responsibleParty || "pending",
    description: resolveIssueDescription(overrides.description, draft, itemIndex),
    suggestion: overrides.suggestion || "",
    // Do not synthesize a generic visual claim when the model did not return
    // one. Empty evidence is safer and visibly reviewable than fake certainty.
    visualEvidence: `${overrides.visualEvidence || ""}`.trim(),
    evidenceSource,
    confidence,
    // 模型自行描述、但拿不出可见依据与原话依据的条目。保留给人工判断，
    // 但必须让核对人看出来这条没有依据，不能与有依据的条目长得一样。
    unsupported: overrides.unsupported === true,
    needsReview: overrides.needsReview === true || confidence !== "high" || evidenceSource === "note",
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

    const clauses = extractAssertedIssueClauses(draft.voiceText || "");
    if (sourceItems.some(item => item.textOrganized)) {
      nextItems.push(...sourceItems);
      return;
    }
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
        suggestion: seed.suggestion || "",
        visualEvidence: seed.visualEvidence,
        evidenceSource: seed.visualEvidence ? seed.evidenceSource : "note",
        confidence: seed.visualEvidence ? seed.confidence : "low",
        needsReview: true
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

  if (!total) {
    return `本次记录未整理出可确认的问题项。照片仍已保留，未记录问题不代表工程验收合格。`;
  }

  const highlightParts = [`本次巡查共整理出 ${total} 个待人工确认的问题项`];

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

function getNormalizedSourceIndex(drafts=[],item={}) {
  if(drafts.length===1)return 0;
  if(Number.isInteger(item.sourceIndex)&&item.sourceIndex>=0&&item.sourceIndex<drafts.length)return item.sourceIndex;
  throw new Error("AI 返回的问题缺少可靠照片来源，请重试或手动整理");
}

function applyExplicitNoteFields(payload, items = []) {
  const drafts = payload.issueDrafts || [];
  const issueCountBySource = new Map();
  items.forEach(item => issueCountBySource.set(item.sourceIndex, (issueCountBySource.get(item.sourceIndex) || 0) + 1));
  return items.map(item => {
    // Explicitly labelled details in the user's note outrank model guesses,
    // but only apply photo-wide fields when that photo produced one issue.
    // With multiple issues there is no reliable source-to-field association.
    if (issueCountBySource.get(item.sourceIndex) !== 1) return item;
    const note = drafts[item.sourceIndex]?.voiceText || '';
    const fieldEvidence = {};
    const result = { ...item };
    (item.textOrganized
      ? ['area', 'category', 'responsiblePartyName']
      : ['area', 'category', 'responsiblePartyName', 'suggestion']).forEach(field => {
      const explicit = extractExplicitField(note, field);
      if (!explicit) return;
      result[field] = explicit.value;
      fieldEvidence[field] = explicit.evidence;
    });
    // Text organization is an extraction aid, not a remediation recommender.
    if (item.textOrganized) result.suggestion = '';
    return Object.keys(fieldEvidence).length
      ? { ...result, fieldEvidence: { ...(item.fieldEvidence || {}), ...fieldEvidence } }
      : item;
  });
}

function normalizeInspectionAiItems(payload, parsedItems = [], options = {}) {
  const drafts = payload.issueDrafts || [];
  const normalized = [];
  const fillMissingDrafts = false; // A: no fabricated issue to fill a photo

  parsedItems.forEach((item, index) => {
    if(!item || typeof item.description!=="string" || !item.description.trim())throw new Error("AI 返回空白问题，请重试或手动整理");
    const fallbackDraft = drafts[index] || {};
    const normalizedSourceIndex = getNormalizedSourceIndex(drafts, item, index);
    const sourceIndex = normalizedSourceIndex;
    const sourceDraft = drafts[sourceIndex] || fallbackDraft || {};
    const visualEvidence = `${item.visualEvidence || ""}`.trim();
    const hasAssertedNote = extractAssertedIssueClauses(sourceDraft.voiceText || "").length > 0;
    const requestedEvidenceSource = ["image", "note", "image+note"].includes(item.evidenceSource)
      ? item.evidenceSource
      : (hasAssertedNote ? "image+note" : "image");

    // 模型给了问题描述，却既没有可见依据、也没有原话依据时，过去是直接丢弃。
    // 那等于让服务端替巡查人做决定，而且不留任何痕迹——核对页根本看不到模型
    // 说过什么，只表现为「这条照片没问题」。实测中这正是「AI 识别到东西、
    // 但报告里什么都没有」的原因。
    // 现在改为保留并明确标注低置信、需现场确认，由核对人自己决定要不要。
    // 真正的空描述仍然在上方拒绝。
    const unsupported = !visualEvidence && !hasAssertedNote;
    const evidenceSource = visualEvidence
      ? requestedEvidenceSource
      : (hasAssertedNote ? "note" : "model-only");
    const confidence = visualEvidence
      ? item.confidence
      : "low";

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
        // AI must not generate treatment advice; explicit inspector input is
        // handled separately by applyExplicitNoteFields.
        suggestion: "",
        visualEvidence,
        evidenceSource,
        confidence,
        unsupported,
        needsReview: item.needsReview === true || !visualEvidence
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

  return normalized.sort((left, right) => {
    if (left.sourceIndex !== right.sourceIndex) {
      return left.sourceIndex - right.sourceIndex;
    }
    return (left.subIssueIndex || 1) - (right.subIssueIndex || 1);
  });
}

function logInspectionAiCandidateCounts(payload, candidates, acceptedItems, stage, observationCount = 0) {
  // Operational telemetry deliberately excludes photos, notes, issue text,
  // project/session identifiers, and provider responses. It only distinguishes
  // a model returning no candidates from server-side evidence filtering.
  const runtime = getAiRuntimeConfig();
  const candidateCount = Array.isArray(candidates) ? candidates.length : 0;
  const acceptedCount = Array.isArray(acceptedItems) ? acceptedItems.length : 0;
  console.info("inspection_ai_candidate_counts", JSON.stringify({
    stage,
    provider: runtime.provider || "unknown",
    model: runtime.model || "unknown",
    photoCount: Array.isArray(payload && payload.issueDrafts) ? payload.issueDrafts.length : 0,
    candidateCount,
    acceptedCount,
    filteredCount: Math.max(0, candidateCount - acceptedCount),
    observationCount: Number.isFinite(Number(observationCount)) ? Math.max(0, Number(observationCount)) : 0
  }));
}

function formatAnnotations(annotations = []) {
  let markerNumber = 0;
  return annotations.map((item, index) => {
    const type = item.type || "mark";
    const start = item.a || item.start || {};
    const end = item.b || item.end || start;
    const percent = value => Math.round((Number(value) || 0) * (Math.abs(Number(value) || 0) <= 1 ? 100 : 1));
    if (type === "point" || ((type === "box" || type === "ellipse") && item.numbered === true)) {
      markerNumber += 1;
      return `编号 ${markerNumber}：中心(${percent(start.x)}%,${percent(start.y)}%)，外圈控制点(${percent(end.x)}%,${percent(end.y)}%)；该区域对应第 ${markerNumber} 条子问题`;
    }
    return `${index + 1}. ${type} 起点(${percent(start.x)}%,${percent(start.y)}%) 终点(${percent(end.x)}%,${percent(end.y)}%)`;
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
  const parts = extractCloudPath(fileID).split("/");
  const allowedFolders = new Set([
    "inspection-originals",
    "inspection-images",
    "inspection-annotated-images"
  ]);
  return parts.length === 4
    && allowedFolders.has(parts[0])
    && parts[1] === "user"
    && parts[2] === `${openId}`
    && Boolean(parts[3])
    && parts[3] !== "."
    && parts[3] !== "..";
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
  const runtimeConfig = getAiRuntimeConfig();
  const draftContexts = await Promise.all((payload.issueDrafts || []).map(async (draft, index) => ({
    index,
    useImage: !shouldSkipImageRecognitionForDraft(draft),
    imageUrl: shouldSkipImageRecognitionForDraft(draft) ? "" : await resolveImageUrl(draft.imagePath, payload.requesterOpenId),
    note: draft.voiceText || "",
    annotationText: formatAnnotations(draft.annotations || [])
  })));

  // Never downgrade an explicitly requested vision analysis to text-only.
  // Otherwise an inaccessible cloud file can masquerade as a successful
  // model run with zero findings.
  const missingVisionImage = draftContexts.find(draft => draft.useImage && !draft.imageUrl);
  if (missingVisionImage) {
    throw new Error(`第 ${missingVisionImage.index + 1} 张照片暂时无法提供给 AI 识图，请重新上传后重试或直接人工核对`);
  }

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
      const imagePart = { url: draft.imageUrl };
      if (runtimeConfig.imageDetail) {
        // 显式要求原分辨率：缺陷细节（裂缝、留缝、偏位）在降采样后会看不出来
        imagePart.detail = runtimeConfig.imageDetail;
      }
      userContent.push({
        type: "image_url",
        image_url: imagePart
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
      timeout: 30000
    }
  );

  const choice = (((response || {}).data || {}).choices || [])[0] || {};
  const message = choice.message || {};
  const parsed = safeJsonParse(message.content || "");
  const modelResult = readInspectionAiResultArrays(parsed);
  const items = modelResult.items;
  const normalizedItems = normalizeInspectionAiItems(payload, items);
  const observations = normalizeVisualObservations(payload, modelResult.observations);
  logInspectionAiCandidateCounts(payload, items, normalizedItems, "vision_batch", observations.length);

  return {
    items: normalizedItems,
    observations,
    summary: parsed.summary || ""
  };
}

function normalizeVisualObservations(payload = {}, values = []) {
  if (!Array.isArray(values)) return [];
  const drafts = payload.issueDrafts || [];
  const counts=new Map(), seen=new Set();
  return values.slice(0, drafts.length * 3).flatMap((item) => {
    const sourceIndex = Number(item && item.sourceIndex);
    const text = `${item && item.text || ""}`.trim().replace(/\s+/g, " ").slice(0, 240);
    const key=`${sourceIndex}:${text}`;
    if (!Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= drafts.length || !text || seen.has(key) || (counts.get(sourceIndex)||0)>=3) return [];
    seen.add(key);counts.set(sourceIndex,(counts.get(sourceIndex)||0)+1);
    return [{sourceIndex, sourcePhotoId: drafts[sourceIndex].id || "", text}];
  });
}

function readInspectionAiResultArrays(parsed = {}) {
  const hasItems = Array.isArray(parsed && parsed.items);
  const hasObservations = Array.isArray(parsed && parsed.observations);
  if (!hasItems && !hasObservations) {
    throw new Error("AI 返回结构不完整，请重试或手动整理");
  }
  // Preserve a valid per-photo observation when a compatible model omits the
  // empty `items` array; malformed responses with neither array still fail.
  return {
    items: hasItems ? parsed.items : [],
    observations: hasObservations ? parsed.observations : []
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
      timeout: 30000
    }
  );

  const choice = (((response || {}).data || {}).choices || [])[0] || {};
  const message = choice.message || {};
  const parsed = safeJsonParse(message.content || "");
  const candidates = Array.isArray(parsed.items) ? parsed.items : [];
  const items = normalizeInspectionAiItems(singlePayload, candidates, {
    fillMissingDrafts: false
  }).map((item) => ({
    ...item,
    sourceIndex: originalIndex
  }));
  logInspectionAiCandidateCounts(singlePayload, candidates, items, "vision_single");

  return items;
}

async function analyzeDraftBatchWithOpenAiCompatible(payload, draftIndexes = []) {
  const batchPayload = createBatchPayload(payload, draftIndexes);
  if (batchPayload.issueDrafts.every(draft => shouldSkipImageRecognitionForDraft(draft) && wantsTextOrganization(draft))) {
    const runtime = getAiRuntimeConfig();
    const rows = await Promise.all(batchPayload.issueDrafts.map(async (draft, index) => {
      const body = { model: runtime.model, temperature: 0.1, response_format: { type: 'json_object' }, messages: textMessages(draft) };
      if (runtime.provider === 'zhipu' || runtime.model.startsWith('glm-4.6v')) body.thinking = { type: 'disabled' };
      const response = await axios.post(`${runtime.baseUrl.replace(/\/$/, '')}/chat/completions`, body, {
        headers: { Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000
      });
      const parsed = safeJsonParse(response?.data?.choices?.[0]?.message?.content || '');
      return normalizeTextItems(draft, parsed.items, draftIndexes[index]);
    }));
    return {items: rows.flat(), observations: []};
  }
  const batchResult = await analyzeInspectionWithOpenAiCompatible(batchPayload);
  const batchItems = (batchResult.items || []).map((item) => ({
    ...item,
    sourceIndex: draftIndexes[item.sourceIndex] !== undefined ? draftIndexes[item.sourceIndex] : draftIndexes[0] || 0
  }));
  const observations = (batchResult.observations || []).map((item) => {
    const sourceIndex = draftIndexes[item.sourceIndex] !== undefined ? draftIndexes[item.sourceIndex] : draftIndexes[0] || 0;
    return {...item, sourceIndex, sourcePhotoId: (payload.issueDrafts || [])[sourceIndex]?.id || ""};
  });
  return {items: batchItems, observations};
}

async function analyzeInspectionBatch(payload, draftIndexes = []) {
  const batchPayload = createBatchPayload(payload, draftIndexes);
  const runtimeConfig = getAiRuntimeConfig();
  assertVisionRuntimeAvailable(batchPayload, runtimeConfig);
  if (isOpenAiCompatibleEnabled(runtimeConfig)) {
    return analyzeDraftBatchWithOpenAiCompatible(payload, draftIndexes);
  }
  if (batchPayload.issueDrafts.some(wantsTextOrganization)) throw new Error('文字整理服务暂未配置，可按原文直接核对');
  const batchResult = await analyzeInspectionWithModel(batchPayload);
  return {items: (batchResult.items || []).map((item) => ({
    ...item,
    sourceIndex: draftIndexes[item.sourceIndex] !== undefined ? draftIndexes[item.sourceIndex] : draftIndexes[0] || 0
  })), observations: (batchResult.observations || []).map((item) => {
    const sourceIndex = draftIndexes[item.sourceIndex] !== undefined ? draftIndexes[item.sourceIndex] : draftIndexes[0] || 0;
    return {...item, sourceIndex, sourcePhotoId: (payload.issueDrafts || [])[sourceIndex]?.id || ""};
  })};
}

async function finalizeTaskItems(payload, mergedItems = []) {
  const textItems = mergedItems.filter(item => item.textOrganized === true);
  const normalized = normalizeInspectionAiItems(payload, mergedItems.filter(item => !item.textOrganized), {fillMissingDrafts:false});
  return applyExplicitNoteFields(payload, ensureVoiceIssueCoverage(payload, normalized.concat(textItems))).map((item,index)=>({
    ...item, id:item.id || "ai-"+item.sourceIndex+"-"+index,
    sourcePhotoId:(payload.issueDrafts || [])[item.sourceIndex]?.id || ""
  }));
}

function buildTaskDraftIndexes(payload = {}) {
  return (payload.issueDrafts || []).map((draft, index) => ({draft,index}))
    .filter(({draft}) => !shouldSkipImageRecognitionForDraft(draft) || wantsTextOrganization(draft))
    .map(({index}) => index);
}

function mapTaskBatchIndexesToPhotoIndexes(task = {}, batchIndexes = []) {
  const batches = Array.isArray(task.batches) ? task.batches : [];
  const photoCount = ((task.payload && task.payload.issueDrafts) || []).length;
  return [...new Set(batchIndexes.flatMap(batchIndex => {
    const batch = batches[batchIndex];
    if (Array.isArray(batch)) return batch;
    if (Number.isInteger(batch)) return [batch];
    return [batchIndex];
  }).filter(index => Number.isInteger(index) && index >= 0 && index < photoCount))].sort((a,b)=>a-b);
}

function buildAiTaskStatus(task = {}, analysis = null) {
  const completedBatchIndexes = Array.isArray(task.completedBatchIndexes)
    ? task.completedBatchIndexes
    : Object.keys(task.batchResults || {})
      .map(Number)
      .filter(Number.isInteger)
      .sort((left, right) => left - right);
  const pendingBatchIndexes = Array.isArray(task.pendingBatchIndexes)
    ? task.pendingBatchIndexes
    : Array.from({length: task.totalBatches || 0}, (_, index) => index)
      .filter(index => !completedBatchIndexes.includes(index));
  return {
    taskId: task._id || "",
    status: task.status || "queued",
    totalBatches: task.totalBatches || 0,
    completedBatches: task.completedBatches || 0,
    totalPhotos: task.totalPhotos || task.totalBatches || 0,
    completedPhotos: task.completedPhotos || task.completedBatches || 0,
    currentBatchIndex: task.currentBatchIndex || 0,
    completedBatchIndexes,
    pendingBatchIndexes,
    completedPhotoIndexes: Array.isArray(task.completedPhotoIndexes) ? task.completedPhotoIndexes : mapTaskBatchIndexesToPhotoIndexes(task, completedBatchIndexes),
    pendingPhotoIndexes: Array.isArray(task.pendingPhotoIndexes) ? task.pendingPhotoIndexes : mapTaskBatchIndexesToPhotoIndexes(task, pendingBatchIndexes),
    errorMessage: task.errorMessage || "",
    startedAt: task.startedAt || 0,
    completedAt: task.completedAt || 0,
    analysis: analysis || task.analysis || null
  };
}

function toUserFacingAiTaskError(error) {
  const status = Number(error && error.response && error.response.status) || 0;
  const code = `${(error && error.code) || ""}`.toUpperCase();
  const raw = `${(error && error.message) || ""}`;
  if (status === 402) return "AI 服务额度暂时不足，可直接按原文核对";
  if (status === 401 || status === 403) return "AI 服务授权已失效，可直接按原文核对";
  if (status === 429) return "AI 服务繁忙，请稍后重试未完成记录或直接核对";
  if (status >= 500) return "AI 服务暂时不可用，请重试未完成记录或直接核对";
  if (code === "ECONNABORTED" || /timeout|timed out|超时/i.test(raw)) return "AI 整理超时，请重试未完成记录或直接核对";
  if (/未配置支持图片分析的模型|文字整理服务暂未配置|AI 返回结构不完整|照片尚未上传|照片暂时无法提供给 AI 识图/.test(raw)) return raw;
  return "AI 整理未完成，请重试未完成记录或直接核对";
}

function isTransientAiTaskError(error) {
  const status = Number(error && error.response && error.response.status) || 0;
  const code = `${(error && error.code) || ""}`.toUpperCase();
  const message = `${(error && error.message) || ""}`;
  return status >= 500
    || ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)
    || /timeout|timed out|socket hang up|network error/i.test(message);
}

/**
 * 每日 AI 任务上限（按账号计）。设为 0 或负数表示不限制。
 *
 * 混元与 ASR 都按量计费，而代码此前没有任何限额：一个用户反复点「AI识图」
 * 或者一批用户同时用，费用会无上限增长，且失败之前没有任何预警。
 * 控制台的用量告警是第一道闸；这里是第二道，防止单账号误用或滥用把额度打光。
 */
const AI_DAILY_TASK_LIMIT = (() => {
  const raw = Number(process.env.AI_DAILY_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
})();

/** 按东八区算「今天」的起点——运营者看到的日界应与自己的直觉一致。 */
function startOfTodayInBeijing() {
  const offsetMs = 8 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + offsetMs);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() - offsetMs;
}

/**
 * 统计账号当日已创建的 AI 任务数。
 * 统计失败时**放行**：额度是成本控制手段，不该因为一次查询异常就挡住
 * 用户记录现场；真正的兜底是控制台的用量告警。
 */
async function assertDailyAiQuota(openId) {
  if (!AI_DAILY_TASK_LIMIT) return { ok: true };
  try {
    const result = await db.collection(AI_TASK_COLLECTION)
      .where({ openId, createdAt: _.gte(startOfTodayInBeijing()) })
      .count();
    const used = Number(result.total) || 0;
    if (used < AI_DAILY_TASK_LIMIT) return { ok: true };
    return {
      ok: false,
      message: `今日 AI 识别次数已达上限（${AI_DAILY_TASK_LIMIT} 次）。可先用手动填写与标注完成记录，明天恢复。`
    };
  } catch (error) {
    console.error("[ai] daily quota check failed, allowing the request", error);
    return { ok: true };
  }
}

async function createAnalysisTask(payload, openId) {
  if(!Array.isArray(payload.issueDrafts)||payload.issueDrafts.length>20)throw new Error("照片数据不完整或超过20张");
  payload.issueDrafts.forEach(p=>{if(!p.imagePath)throw new Error("照片尚未上传");assertMedia(p.imagePath,openId);assertMedia(p.annotatedImagePath,openId);});
  const enhancedPayload = await enrichPayloadWithMemory(payload);
  const draftIndexes = buildTaskDraftIndexes(enhancedPayload);
  const batches = chunkArray(draftIndexes, AI_BATCH_SIZE);
  const now = Date.now();
  const id=requestKey("analysis",openId,payload.requestId || "legacy-"+hash(payload));
  const created = await reserve(db.collection(AI_TASK_COLLECTION),id,hash(payload),{
      status: "queued",
      lockUntil: 0,
      // 记录归属：getInspectionTaskStatus 据此校验调用者，
      // 避免只要猜到 taskId 就能读到他人的问题描述、图片路径与语音文本
      openId,
      projectId: enhancedPayload.projectId || "",
      payload: enhancedPayload,
      batches,
      partialItems: [],
      batchObservations: {},
      totalBatches: batches.length,
      completedBatches: 0,
      totalPhotos: draftIndexes.length,
      completedPhotos: 0,
      completedPhotoIndexes: [],
      pendingPhotoIndexes: draftIndexes.slice(),
      currentBatchIndex: 0,
      completedBatchIndexes: [],
      pendingBatchIndexes: batches.map((_, index) => index),
      errorMessage: "",
      model: getAiRuntimeConfig().model,
      startedAt: 0,
      completedAt: 0,
      createdAt: now,
      expiresAt: now + AI_TASK_TTL_MS,
      updatedAt: now
  });
  const task = await db.collection(AI_TASK_COLLECTION).doc(created._id).get();
  return task.data;
}

async function processAnalysisTask(task) {
  if (!task || ["success", "failed", "cancelled"].includes(task.status)) {
    return task;
  }
  const payload = task.payload || {};
  const batches = task.batches || [];

  if (!batches.length) {
    // 全部照片都已有人工说明时不调用视觉模型，但仍把明确陈述整理成
    // 可核对的问题清单。这样「不识图」不等于「丢掉人工输入」。
    const items = await finalizeTaskItems(payload, []);
    const analysis = {
      items,
      observations: [],
      summary: buildInspectionSummary(payload, items),
      aiMode: items.length ? "manual" : "empty",
      memoryHint: payload.memoryHint || "",
      memoryAlerts: []
    };
    await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
      data: {
        status: "success",
        analysis,
        completedBatches: 0,
        completedPhotos: 0,
        completedAt: Date.now(),
        updatedAt: Date.now()
      }
    });
    const refreshed = await db.collection(AI_TASK_COLLECTION).doc(task._id).get();
    return refreshed.data;
  }

  const startedAt = task.startedAt || Date.now();
  await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
    data: { status: "running", errorMessage: "", startedAt, updatedAt: Date.now() }
  });

  // 在一次调用里尽量多处理几批，而不是每次只处理一批。
  //
  // 原来每轮只做一批。配合「每次请求只放 1 张图」（避免超过云函数 60 秒上限），
  // 20 张照片就要 20 轮客户端轮询，太慢。
  // 现在按时间预算循环，每轮并发处理 AI_BATCH_PARALLEL_LIMIT 批。
  let cursor = task.currentBatchIndex || 0;
  const completed={...(task.batchResults||{})};
  const observationResults={...(task.batchObservations||{})};
  const legacyItems=!task.batchResults?(task.partialItems||[]):[];
  if(!task.batchResults)for(let i=0;i<cursor;i++)completed[i]=[];
  let mergedItems=legacyItems.slice();
  const getCompletedBatchIndexes = () => Object.keys(completed)
    .map(Number)
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
  const getPendingBatchIndexes = () => batches.map((_, index) => index)
    .filter(index => !Object.prototype.hasOwnProperty.call(completed, index));
  const checkpointState = () => {
    const completedBatchIndexes = getCompletedBatchIndexes();
    const pendingBatchIndexes = getPendingBatchIndexes();
    return {
      completedBatchIndexes,
      pendingBatchIndexes,
      completedPhotoIndexes: mapTaskBatchIndexesToPhotoIndexes(task, completedBatchIndexes),
      pendingPhotoIndexes: mapTaskBatchIndexesToPhotoIndexes(task, pendingBatchIndexes),
      completedBatches: completedBatchIndexes.length,
      completedPhotos: completedBatchIndexes.length,
      // This is the next real pending batch, not the number of completed
      // batches. It remains correct when parallel requests finish out of order.
      currentBatchIndex: pendingBatchIndexes.length ? pendingBatchIndexes[0] : batches.length
    };
  };
  const deadline=Date.now()+AI_TASK_TIME_BUDGET_MS;
  const failedThisAdvance = new Set();
  let firstFailure = null;
  try {
    while(true){
      if (await isAnalysisTaskCancelled(task._id)) return await getAnalysisTask(task._id);
      const pending=batches.map((_,i)=>i).filter(i=>!Object.prototype.hasOwnProperty.call(completed,i) && !failedThisAdvance.has(i));
      if(!pending.length)break;
      if(deadline-Date.now()<31000)break;
      const indices=pending.slice(0,AI_BATCH_PARALLEL_LIMIT);
      // Requests still run in parallel, but successful photos checkpoint one at
      // a time through this serialized writer. Read-only status polling can now
      // show 1/20, 2/20... instead of waiting for the slowest request in a wave.
      let checkpointChain=Promise.resolve();
      const results=await Promise.all(indices.map(async i=>{
        try {
          let batchResult;
          try {
            batchResult=await analyzeInspectionBatch(payload,batches[i]);
          } catch(firstError) {
            if (await isAnalysisTaskCancelled(task._id)) return {i,error:firstError};
            const retryKey=`automaticRetryCount_${i}`;
            const automaticRetryCount=Number(task[retryKey])||0;
            if(automaticRetryCount>=1 || !isTransientAiTaskError(firstError) || deadline-Date.now()<AI_TASK_AUTOMATIC_RETRY_RESERVE_MS) throw firstError;
            // Bound automatic recovery to one retry per photo for transient
            // transport/provider failures. Persist before retry so a function
            // restart cannot create an unbounded paid retry loop.
            await db.collection(AI_TASK_COLLECTION).doc(task._id).update({data:{[retryKey]:automaticRetryCount+1,updatedAt:Date.now()}});
            await new Promise(resolve=>setTimeout(resolve,350));
            batchResult=await analyzeInspectionBatch(payload,batches[i]);
          }
          checkpointChain=checkpointChain.then(async()=>{
            if (await isAnalysisTaskCancelled(task._id)) return;
            completed[i]=batchResult.items||[];
            observationResults[i]=batchResult.observations||[];
            const checkpoint=checkpointState();
            cursor=checkpoint.completedBatches;
            mergedItems=legacyItems.concat(...Object.keys(completed).sort((a,b)=>Number(a)-Number(b)).map(key=>completed[key]));
            await db.collection(AI_TASK_COLLECTION).doc(task._id).update({data:{
              batchResults:completed,
              batchObservations:observationResults,
              ...checkpoint,
              partialItems:mergedItems,
              updatedAt:Date.now()
            }});
          });
          await checkpointChain;
          return {i,batchResult};
        } catch(error) {
          return {i,error};
        }
      }));
      const failures=results.filter(r=>r.error);
      if (await isAnalysisTaskCancelled(task._id)) return await getAnalysisTask(task._id);
      failures.forEach(failure=>{failedThisAdvance.add(failure.i);if(!firstFailure)firstFailure=failure.error;});
      // A single failed photo must not prevent later photos being attempted.
      // Account-wide failures, in contrast, stop new paid calls immediately.
      const unavailable=failures.find(failure=>[401,402,403,429].includes(Number(failure.error?.response?.status)));
      if(unavailable)throw unavailable.error;
    }
    if(firstFailure)throw firstFailure;
    const finalCheckpoint=checkpointState();
    cursor=finalCheckpoint.completedBatches;
    mergedItems=legacyItems.concat(...Object.keys(completed).sort((a,b)=>Number(a)-Number(b)).map(i=>completed[i]));

    if (cursor >= batches.length) {
      const finalItems = await finalizeTaskItems(payload, mergedItems);
      const observations = Object.keys(observationResults).sort((a,b)=>Number(a)-Number(b))
        .flatMap(key => observationResults[key] || []);
      const finalAnalysis = {
        items: finalItems,
        observations,
        summary: buildInspectionSummary(payload, finalItems),
        aiMode: "model",
        memoryHint: payload.memoryHint || "",
        memoryAlerts: buildMemoryAlerts(payload, finalItems)
      };
      const finalized = await db.collection(AI_TASK_COLLECTION).where(_.and([
        {_id:task._id}, {cancelRequestedAt:_.exists(false)}
      ])).update({
        data: {
          status: "success",
          analysis: finalAnalysis,
          completedBatches: cursor,
          ...finalCheckpoint,
          completedAt: Date.now(),
          partialItems: _.remove(),
          batchResults: _.remove(),
          batchObservations: _.remove(),
          payload: _.remove(),
          batches: _.remove(),
          updatedAt: Date.now()
        }
      });
      if (!finalized.stats || !finalized.stats.updated) return await getAnalysisTask(task._id);
      const done = await db.collection(AI_TASK_COLLECTION).doc(task._id).get();
      return Object.assign({}, done.data, { runtimeAnalysis: finalAnalysis });
    }

    if (await isAnalysisTaskCancelled(task._id)) return await getAnalysisTask(task._id);
    await db.collection(AI_TASK_COLLECTION).where(_.and([
      {_id:task._id}, {cancelRequestedAt:_.exists(false)}
    ])).update({
      data: {
        status: "running",
        ...checkpointState(),
        partialItems: mergedItems,
        updatedAt: Date.now()
      }
    });
  } catch (error) {
    console.error("processAnalysisTask failed", error);
    if (await isAnalysisTaskCancelled(task._id)) return await getAnalysisTask(task._id);
    await db.collection(AI_TASK_COLLECTION).doc(task._id).update({
      data: {
        status: "failed",
        errorMessage: toUserFacingAiTaskError(error),
        ...checkpointState(),
        failedAt: Date.now(),
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

async function isAnalysisTaskCancelled(taskId) {
  const task = await getAnalysisTask(taskId);
  return !task || task.status === "cancelled" || !!task.cancelRequestedAt;
}

async function analyzeInspectionWithModel(payload) {
  const runtimeConfig = getAiRuntimeConfig();
  assertVisionRuntimeAvailable(payload, runtimeConfig);
  if (isOpenAiCompatibleEnabled(runtimeConfig)) {
    const drafts = payload.issueDrafts || [];

    // 不分「少量走单次请求、多量才分批」——统一分批。
    //
    // 原来 drafts.length <= 5 时会把所有图片塞进一次请求。实测踩到：
    // 2 张高分辨率图（detail: high）一次请求就可能超过云函数 60 秒上限，
    // 整个调用被杀死，用户只看到「AI 整理中」一直转。
    // 现在每批只放 AI_BATCH_SIZE 张，单次请求耗时可控。
    const draftIndexes = buildTaskDraftIndexes(payload);
    const batches = chunkArray(draftIndexes, AI_BATCH_SIZE);
    const batchResults = await runWithConcurrency(
      batches.map((batchIndexes) => async () => analyzeDraftBatchWithOpenAiCompatible(payload, batchIndexes)),
      AI_BATCH_PARALLEL_LIMIT
    );
    const mergedItems = batchResults.flatMap(result => result.items || []);
    const observations = batchResults.flatMap(result => result.observations || []);

    return {
      items: await finalizeTaskItems(payload, mergedItems),
      observations,
      summary: ""
    };
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
  const modelResult = readInspectionAiResultArrays(parsed);
  const items = modelResult.items;

  const normalizedCandidates = normalizeInspectionAiItems(payload, items);
  const observations = normalizeVisualObservations(payload, modelResult.observations);
  logInspectionAiCandidateCounts(payload, items, normalizedCandidates, "hunyuan_vision", observations.length);
  const normalizedItems = applyExplicitNoteFields(payload, ensureVoiceIssueCoverage(payload, normalizedCandidates));
  return {
    items: normalizedItems.map((item) => {
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
    observations,
    summary: parsed.summary || ""
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;
  const { OPENID } = cloud.getWXContext();

  try {
    switch (action) {
      case "getRuntimeStatus":
        return {
          success: true,
          data: buildSafeRuntimeStatus()
        };

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
              observations: modelResult.observations || [],
              summary: modelResult.summary || buildInspectionSummary(enhancedPayload, modelResult.items),
              aiMode: "model",
              memoryHint: enhancedPayload.memoryHint || "",
              memoryAlerts
            }
          };
        } catch (error) {
          console.error("analyzeInspectionWithModel failed", error);

          // 明确失败，不回退到模板内容。
          //
          // 原实现在模型调用失败时会用 buildInspectionItems 生成一批
          // 「现场问题 1 / 客厅吊顶」之类的猜测项并当作分析结果返回。
          // 巡查报告是要拿去和施工方对账、甚至作为整改依据的，
          // 把编造的问题混进交付物比直接报错危险得多 ——
          // 用户会以为这些是 AI 看照片看出来的。
          return {
            success: false,
            message: `AI 分析失败：${(error && error.message) || "未知错误"}。请检查 ai 云函数的模型配置，或稍后重试。`,
            error: {
              code: "AiAnalyzeFailed",
              detail: (error && error.message) || ""
            }
          };
        }
      }

      case "createInspectionTask": {
        const access = await assertProjectAccess(payload.projectId, OPENID);
        if (!access.ok) {
          return { success: false, message: access.message };
        }

        const quota = await assertDailyAiQuota(OPENID);
        if (!quota.ok) {
          return { success: false, message: quota.message };
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

      case "readInspectionTaskStatus":
      case "advanceInspectionTask":
      case "cancelInspectionTask":
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

        if (action === "cancelInspectionTask") {
          if (["queued", "running", "failed"].includes(task.status)) {
            await db.collection(AI_TASK_COLLECTION).doc(task._id).update({data:{
              status:"cancelled", cancelRequestedAt:Date.now(), updatedAt:Date.now()
            }});
            task = await getAnalysisTask(task._id);
          }
          return {success:true,data:buildAiTaskStatus(task,task.analysis||null)};
        }

        if(action !== "readInspectionTaskStatus" && ["queued","running","failed"].includes(task.status)) {
          const now=Date.now();
          const claimed=await db.collection(AI_TASK_COLLECTION).where(_.and([
            {_id:task._id,status:_.in(["queued","running","failed"])},_.or([{lockUntil:_.lte(now)},{lockUntil:_.exists(false)}])
          ])).update({data:{lockUntil:now+180000}});
          if(claimed.stats && claimed.stats.updated){
            try{const latest=await getAnalysisTask(task._id);task=["success","cancelled"].includes(latest.status)?latest:await processAnalysisTask({...latest,status:"running"});}
            finally{await db.collection(AI_TASK_COLLECTION).doc(task._id).update({data:{lockUntil:0}});}
          }
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
