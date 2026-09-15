const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

/** 分享 token 前缀：用于把可猜测的旧值（report-<时间戳>）识别为无效 */
const SHARE_TOKEN_PREFIX = "sr";

const db = cloud.database();
const _ = db.command;

async function assertProjectOwner(projectId, openId) {
  if (!projectId) {
    return {
      ok: false,
      message: "缺少项目"
    };
  }
  const doc = await db.collection("projects").doc(projectId).get();
  const project = doc.data;
  if (!project || project.deleted || project.ownerOpenId !== openId) {
    return {
      ok: false,
      message: "无权访问该项目"
    };
  }
  return {
    ok: true,
    project
  };
}

async function assertReportAccess(reportId, openId) {
  const reportDoc = await db.collection("reports").doc(reportId).get();
  const reportRow = reportDoc.data;
  if (!reportRow || reportRow.deleted) {
    return {
      ok: false,
      message: "报告不存在"
    };
  }
  const p = await assertProjectOwner(reportRow.projectId, openId);
  if (!p.ok) {
    return {
      ok: false,
      message: p.message
    };
  }
  return {
    ok: true,
    report: reportRow,
    project: p.project
  };
}

const PDF_SERVICE_BASE_URLS = (
  process.env.PDF_SERVICE_URLS || "https://pdf.haolizhiguan.cn"
).split(",").map((s) => s.trim()).filter(Boolean);
const PDF_API_KEY = process.env.PDF_API_KEY || "";

function getFileNameFromHeaders(headers = {}) {
  const disposition = headers["content-disposition"] || headers["Content-Disposition"] || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (error) {
      return utf8Match[1];
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return (plainMatch && plainMatch[1]) || "";
}

function formatPdfDate(value) {
  if (!value) {
    return "";
  }
  const text = `${value}`;
  if (/^\d{8}$/.test(text)) {
    return text;
  }
  return text.replace(/\D/g, "").slice(0, 8);
}

function buildPdfFileName(reportPayload = {}) {
  const projectName = `${reportPayload.projectName || reportPayload.title || "report"}`.trim();
  const datePart = formatPdfDate(reportPayload.inspectionDate);
  return `${projectName}${datePart || ""}.pdf`;
}

function buildServiceUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function isPdfBuffer(fileBuffer) {
  return Boolean(fileBuffer && fileBuffer.length >= 4 && fileBuffer.slice(0, 4).toString("utf8") === "%PDF");
}

function tryParseJsonBuffer(fileBuffer) {
  try {
    return JSON.parse(fileBuffer.toString("utf8"));
  } catch (error) {
    return null;
  }
}

function tryParseByteObjectBuffer(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return null;
  }
  const keys = Object.keys(parsed);
  if (!keys.length || !keys.every((key) => /^\d+$/.test(key))) {
    return null;
  }
  const sortedValues = keys
    .sort((first, second) => Number(first) - Number(second))
    .map((key) => Number(parsed[key]) || 0);
  return Buffer.from(sortedValues);
}

function requestJsonFromUrl(serviceUrl, method = "GET", payload) {
  return new Promise((resolve, reject) => {
    const hasBody = payload !== undefined;
    const requestBody = hasBody ? JSON.stringify(payload) : "";
    const client = serviceUrl.startsWith("https://") ? https : http;
    const request = client.request(serviceUrl, {
      method,
      headers: Object.assign(
        hasBody ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(requestBody)
        } : {},
        PDF_API_KEY ? { "x-api-key": PDF_API_KEY } : {}
      ),
      timeout: 30000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const fileBuffer = Buffer.concat(chunks);
        if (response.statusCode >= 400) {
          const errorText = fileBuffer.toString("utf8");
          try {
            const parsed = JSON.parse(errorText || "{}");
            reject(new Error(parsed.message || "PDF 服务调用失败"));
          } catch (error) {
            reject(new Error(errorText || "PDF 服务调用失败"));
          }
          return;
        }
        const parsed = tryParseJsonBuffer(fileBuffer);
        if (parsed) {
          resolve(parsed);
          return;
        }
        reject(new Error(`PDF 服务返回内容异常：url=${serviceUrl} status=${response.statusCode || 0}`));
        return;
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("PDF 服务请求超时"));
    });
    request.on("error", (error) => {
      reject(new Error(error.message || "PDF 服务请求失败"));
    });
    if (hasBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

function requestPdfBufferFromUrl(serviceUrl) {
  return new Promise((resolve, reject) => {
    const client = serviceUrl.startsWith("https://") ? https : http;
    const request = client.request(serviceUrl, {
      method: "GET",
      timeout: 300000,
      headers: PDF_API_KEY ? { "x-api-key": PDF_API_KEY } : {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const fileBuffer = Buffer.concat(chunks);
        if (response.statusCode >= 400) {
          const errorText = fileBuffer.toString("utf8");
          reject(new Error(errorText || `PDF 下载失败：status=${response.statusCode || 0}`));
          return;
        }
        if (isPdfBuffer(fileBuffer)) {
          resolve({
            fileBuffer,
            fileName: getFileNameFromHeaders(response.headers) || "report.pdf"
          });
          return;
        }
        const parsed = tryParseJsonBuffer(fileBuffer);
        const byteObjectBuffer = tryParseByteObjectBuffer(parsed);
        if (isPdfBuffer(byteObjectBuffer)) {
          resolve({
            fileBuffer: byteObjectBuffer,
            fileName: getFileNameFromHeaders(response.headers) || "report.pdf"
          });
          return;
        }
        reject(new Error(`PDF 下载内容异常：url=${serviceUrl} status=${response.statusCode || 0}`));
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("PDF 下载超时"));
    });
    request.on("error", (error) => {
      reject(new Error(error.message || "PDF 下载失败"));
    });
    request.end();
  });
}

async function requestJson(payloadPath, method = "GET", payload) {
  let lastError = null;
  for (const baseUrl of PDF_SERVICE_BASE_URLS) {
    try {
      return await requestJsonFromUrl(buildServiceUrl(baseUrl, payloadPath), method, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("PDF 服务请求失败");
}

async function requestPdfBuffer(pathname) {
  let lastError = null;
  for (const baseUrl of PDF_SERVICE_BASE_URLS) {
    try {
      return await requestPdfBufferFromUrl(buildServiceUrl(baseUrl, pathname));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("PDF 服务请求失败");
}

async function uploadPdfBuffer(fileBuffer, fileName) {
  const safeName = `${Date.now()}-${fileName}`.replace(/[\\/:*?"<>|]/g, "-");
  const tempFilePath = path.join(os.tmpdir(), safeName);
  await fs.promises.writeFile(tempFilePath, fileBuffer);
  try {
    const uploaded = await cloud.uploadFile({
      cloudPath: `reports/${safeName}`,
      fileContent: fs.createReadStream(tempFilePath)
    });
    return uploaded.fileID;
  } finally {
    fs.promises.unlink(tempFilePath).catch(() => {});
  }
}

async function buildReportData(payload) {
  const { OPENID } = cloud.getWXContext();
  const inspection = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspection.data || inspection.data.deleted) {
    return {
      success: false,
      message: "巡查不存在"
    };
  }
  const projectCheck = await assertProjectOwner(inspection.data.projectId, OPENID);
  if (!projectCheck.ok) {
    return {
      success: false,
      message: projectCheck.message
    };
  }
  const projectRow = projectCheck.project;
  const items = await db.collection("inspection_items").where({
    inspectionId: payload.inspectionId,
    deleted: false
  }).orderBy("sortOrder", "asc").get();
  const user = await db.collection("users").where({
    openId: inspection.data.inspectorOpenId,
    deleted: false
  }).get();
  const settings = await db.collection("app_settings").where({
    openId: inspection.data.inspectorOpenId,
    deleted: false
  }).get();
  const appSettings = settings.data[0] || {};

  return {
    success: true,
    data: {
      inspectionId: inspection.data._id,
      projectId: projectRow._id,
      title: `${projectRow.name}巡查报告`,
      projectName: projectRow.name,
      inspectionDate: inspection.data.inspectionDate,
      inspectionDateText: new Date(inspection.data.inspectionDate).toLocaleDateString("zh-CN"),
      inspectorName: user.data[0] ? user.data[0].nickname : "巡查员",
      inspectorPhone: user.data[0] ? (user.data[0].phone || user.data[0].mobile || "") : "",
      companyName: appSettings.companyName || "",
      companyPhone: appSettings.companyPhone || "",
      companyAddress: appSettings.companyAddress || "",
      logoFileId: appSettings.logoFileId || "",
      reportTemplate: appSettings.reportTemplate || "default",
      summary: inspection.data.aiSummary || `本次巡查共识别 ${items.data.length} 个问题项，建议按严重程度优先处理高风险问题。`,
      contextNote: inspection.data.note || "",
      items: items.data
    }
  };
}

async function saveReport(payload) {
  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  const reportStatus = payload.status || (payload.pdfFileId ? "generated" : "draft");

  if (payload.reportId) {
    const access = await assertReportAccess(payload.reportId, OPENID);
    if (!access.ok) {
      return {
        success: false,
        message: access.message
      };
    }
    const updateData = {
      title: payload.title,
      summary: payload.summary,
      contextNote: payload.contextNote || "",
      companyName: payload.companyName || "",
      companyPhone: payload.companyPhone || "",
      companyAddress: payload.companyAddress || "",
      logoFileId: payload.logoFileId || "",
      reportTemplate: payload.reportTemplate || "default",
      status: reportStatus,
      updatedAt: now,
      updatedBy: OPENID
    };
    if (payload.pdfFileId !== undefined) {
      updateData.pdfFileId = payload.pdfFileId;
    }
    if (payload.pdfTemplateVersion !== undefined) {
      updateData.pdfTemplateVersion = payload.pdfTemplateVersion || "";
    }
    if (payload.pdfTaskId !== undefined) {
      updateData.pdfTaskId = payload.pdfTaskId || "";
    }
    if (payload.pdfTaskStatus !== undefined) {
      updateData.pdfTaskStatus = payload.pdfTaskStatus || "";
    }
    if (payload.pdfErrorMessage !== undefined) {
      updateData.pdfErrorMessage = payload.pdfErrorMessage || "";
    }
    if (reportStatus === "generated") {
      updateData.generatedAt = payload.generatedAt || now;
    }
    await db.collection("reports").doc(payload.reportId).update({
      data: updateData
    });
    const report = await db.collection("reports").doc(payload.reportId).get();
    return {
      success: true,
      data: report.data
    };
  }

  const inspDoc = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspDoc.data || inspDoc.data.deleted) {
    return {
      success: false,
      message: "巡查不存在"
    };
  }
  if (inspDoc.data.projectId !== payload.projectId) {
    return {
      success: false,
      message: "项目与巡查不匹配"
    };
  }
  const createAccess = await assertProjectOwner(payload.projectId, OPENID);
  if (!createAccess.ok) {
    return {
      success: false,
      message: createAccess.message
    };
  }

  const data = {
    inspectionId: payload.inspectionId,
    projectId: payload.projectId,
    title: payload.title,
    summary: payload.summary,
    contextNote: payload.contextNote || "",
    companyName: payload.companyName || "",
    companyPhone: payload.companyPhone || "",
    companyAddress: payload.companyAddress || "",
    logoFileId: payload.logoFileId || "",
    reportTemplate: payload.reportTemplate || "default",
    pdfFileId: payload.pdfFileId || "",
    pdfTemplateVersion: payload.pdfTemplateVersion || "",
    pdfTaskId: payload.pdfTaskId || "",
    pdfTaskStatus: payload.pdfTaskStatus || "",
    pdfErrorMessage: payload.pdfErrorMessage || "",
    coverLogoFileId: "",
    // 创建时就生成分享 token。
    // onShareAppMessage 是同步函数、无法等待网络，所以 token 必须随报告一起就绪。
    // 不用 `report-<时间戳>`：时间戳可被猜测，等于没有保护。
    shareToken: `${SHARE_TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`,
    status: reportStatus,
    generatedAt: reportStatus === "generated" ? (payload.generatedAt || now) : 0,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: OPENID,
    updatedBy: OPENID
  };

  const created = await db.collection("reports").add({
    data
  });

  await db.collection("inspections").doc(payload.inspectionId).update({
    data: {
      reportId: created._id,
      updatedAt: now,
      updatedBy: OPENID
    }
  });

  return {
    success: true,
    data: {
      ...data,
      _id: created._id
    }
  };
}

async function fetchReport(reportId) {
  const report = await db.collection("reports").doc(reportId).get();
  return report.data;
}

async function markReportPdfState(reportId, data = {}) {
  const now = Date.now();
  await db.collection("reports").doc(reportId).update({
    data: {
      ...data,
      updatedAt: now
    }
  });
  return fetchReport(reportId);
}

/**
 * 只读读者（业主、施工方）不应该看到的内部字段。
 * 分享链接是给外部人看的，任务号、错误堆栈这类运维信息与业务无关。
 */
const READER_HIDDEN_FIELDS = [
  "pdfTaskId",
  "pdfTaskStatus",
  "pdfErrorMessage",
  "pdfTemplateVersion",
  "createdBy",
  "updatedBy",
  "deleted"
];

function stripInternalFields(report = {}) {
  const safe = Object.assign({}, report);
  READER_HIDDEN_FIELDS.forEach((field) => {
    delete safe[field];
  });
  return safe;
}

async function detailReport(payload) {
  const { OPENID } = cloud.getWXContext();
  const report = await db.collection("reports").doc(payload.reportId).get();
  if (!report.data || report.data.deleted) {
    return {
      success: false,
      message: "报告不存在"
    };
  }

  // 两种访问方式：
  // 1. 项目所有者本人
  // 2. 持有有效分享 token 的读者（业主、施工方）
  //
  // 报告要转发给不是小程序用户、也不该拿到账号权限的人看。
  // 用不可猜测的 token 做只读访问，比放开 owner 鉴权安全得多。
  const ownerCheck = await assertProjectOwner(report.data.projectId, OPENID);
  const tokenMatched = Boolean(
    payload.shareToken
    && report.data.shareToken
    && payload.shareToken === report.data.shareToken
  );

  if (!ownerCheck.ok && !tokenMatched) {
    return {
      success: false,
      message: "无权访问该报告"
    };
  }

  const build = await buildReportData({
    inspectionId: report.data.inspectionId
  });
  if (!build.success) {
    return build;
  }

  const merged = {
    ...build.data,
    ...report.data,
    items: build.data.items,
    inspectionDate: build.data.inspectionDate,
    inspectionDateText: build.data.inspectionDateText,
    inspectorName: build.data.inspectorName,
    inspectorPhone: build.data.inspectorPhone,
    projectName: build.data.projectName,
    title: report.data.title || build.data.title,
    summary: report.data.summary || build.data.summary,
    contextNote: report.data.contextNote || build.data.contextNote
  };

  return {
    success: true,
    data: Object.assign(
      {},
      ownerCheck.ok ? merged : stripInternalFields(merged),
      // 告知客户端当前是哪种访问方式：分享进来的读者不应看到生成/删除等操作
      { accessMode: ownerCheck.ok ? "owner" : "shared" }
    )
  };
}

/**
 * 为报告生成（或复用）分享 token。
 *
 * token 一旦生成就复用——已经转发出去的链接不该因为再次分享而失效。
 * 早期的 `report-<时间戳>` 可被猜测，视为无效并重新生成。
 */
async function createShareToken(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertReportAccess(payload.reportId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }

  const existing = `${access.report.shareToken || ""}`;
  if (existing.startsWith(SHARE_TOKEN_PREFIX) && existing.length >= 24) {
    return {
      success: true,
      data: { shareToken: existing }
    };
  }

  const shareToken = `${SHARE_TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
  await db.collection("reports").doc(payload.reportId).update({
    data: {
      shareToken,
      updatedAt: Date.now()
    }
  });

  return {
    success: true,
    data: { shareToken }
  };
}

async function listReports(payload = {}) {
  const { OPENID } = cloud.getWXContext();
  const projects = await db.collection("projects").where({
    ownerOpenId: OPENID,
    deleted: false
  }).get();
  const projectIds = (projects.data || []).map((item) => item._id);
  if (!projectIds.length) {
    return {
      success: true,
      data: {
        list: [],
        total: 0
      }
    };
  }

  const query = {
    deleted: false,
    projectId: _.in(projectIds)
  };

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
    query.projectId = payload.projectId;
  }

  const countResult = await db.collection("reports").where(query).count();
  const total = countResult.total || 0;
  const pageSize = Math.min(Math.max(Number(payload.pageSize) || 20, 1), 100);
  const page = Math.max(Number(payload.page) || 1, 1);
  const skip = (page - 1) * pageSize;

  const result = await db.collection("reports").where(query)
    .orderBy("generatedAt", "desc")
    .skip(skip)
    .limit(pageSize)
    .get();

  return {
    success: true,
    data: {
      list: result.data || [],
      total,
      page,
      pageSize
    }
  };
}

async function removeReport(payload) {
  if (!payload.reportId) {
    return {
      success: false,
      message: "缺少报告ID"
    };
  }

  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  const report = await db.collection("reports").doc(payload.reportId).get();
  if (!report.data || report.data.deleted) {
    return {
      success: true,
      data: true
    };
  }

  const access = await assertProjectOwner(report.data.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }

  await db.collection("reports").doc(payload.reportId).update({
    data: {
      deleted: true,
      updatedAt: now,
      updatedBy: OPENID
    }
  });

  if (report.data.inspectionId) {
    try {
      const inspection = await db.collection("inspections").doc(report.data.inspectionId).get();
      if (inspection.data && inspection.data.reportId === payload.reportId) {
        await db.collection("inspections").doc(report.data.inspectionId).update({
          data: {
            reportId: "",
            updatedAt: now,
            updatedBy: OPENID
          }
        });
      }
    } catch (error) {
    }
  }

  return {
    success: true,
    data: true
  };
}

/**
 * 已移除 generatePdf 同步出图通道。
 *
 * 原因是它同时存在两个问题：
 * 1. 没有任何鉴权——任意登录用户都能调用；
 * 2. 把客户端传入的 payload 直接当作 URL path 交给 PDF 服务，
 *    而请求头里带着服务端的 PDF_API_KEY。
 *
 * 两者相加等于：任何登录用户都能借我们的密钥驱动 Puppeteer，
 * 并把结果写进 reports/ 云存储目录。
 *
 * 现在出图只走 createPdfTask → getPdfTaskStatus，两步都有归属校验。
 */

async function createPdfTask(payload) {
  if (!payload.reportId || !payload.reportPayload) {
    return {
      success: false,
      message: "缺少报告ID或PDF任务数据"
    };
  }
  const { OPENID } = cloud.getWXContext();
  const access = await assertReportAccess(payload.reportId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const response = await requestJson("/api/report-pdf/tasks", "POST", payload.reportPayload);
  if (!response || !response.success || !response.data || !response.data.taskId) {
    throw new Error(response && response.message ? response.message : "创建 PDF 任务失败");
  }
  const report = await markReportPdfState(payload.reportId, {
    status: "pdf_generating",
    pdfFileId: "",
    pdfTemplateVersion: "",
    pdfTaskId: response.data.taskId,
    pdfTaskStatus: response.data.status || "queued",
    pdfErrorMessage: "",
    generatedAt: 0
  });
  return {
    success: true,
    data: {
      taskId: response.data.taskId,
      taskStatus: response.data.status || "queued",
      report
    }
  };
}

async function getPdfTaskStatus(payload) {
  if (!payload.reportId || !payload.taskId) {
    return {
      success: false,
      message: "缺少报告ID或任务ID"
    };
  }
  const { OPENID } = cloud.getWXContext();
  const access = await assertReportAccess(payload.reportId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const response = await requestJson(`/api/report-pdf/tasks/${payload.taskId}`, "GET");
  if (!response || !response.success || !response.data) {
    throw new Error(response && response.message ? response.message : "获取 PDF 任务状态失败");
  }
  const task = response.data;
  if (task.status === "success") {
    const currentReport = await fetchReport(payload.reportId);
    if (currentReport && currentReport.pdfFileId && currentReport.status === "generated") {
      return {
        success: true,
        data: {
          taskStatus: "success",
          report: currentReport
        }
      };
    }
    const fileResult = await requestPdfBuffer(`/api/report-pdf/tasks/${payload.taskId}/download`);
    const pdfFileId = await uploadPdfBuffer(
      fileResult.fileBuffer,
      fileResult.fileName || buildPdfFileName(currentReport || {})
    );
    const report = await markReportPdfState(payload.reportId, {
      status: "generated",
      pdfFileId,
      pdfTemplateVersion: payload.pdfTemplateVersion || currentReport.pdfTemplateVersion || "",
      pdfTaskId: payload.taskId,
      pdfTaskStatus: "success",
      pdfErrorMessage: "",
      generatedAt: Date.now()
    });
    return {
      success: true,
      data: {
        taskStatus: "success",
        report
      }
    };
  }
  if (task.status === "failed") {
    const report = await markReportPdfState(payload.reportId, {
      status: "pdf_failed",
      pdfTaskId: payload.taskId,
      pdfTaskStatus: "failed",
      pdfErrorMessage: task.errorMessage || "PDF 生成失败"
    });
    return {
      success: true,
      data: {
        taskStatus: "failed",
        report,
        errorMessage: task.errorMessage || "PDF 生成失败"
      }
    };
  }
  const report = await markReportPdfState(payload.reportId, {
    status: "pdf_generating",
    pdfTaskId: payload.taskId,
    pdfTaskStatus: task.status || "queued"
  });
  return {
    success: true,
    data: {
      taskStatus: task.status || "queued",
      report
    }
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  try {
    switch (action) {
      case "build":
        return await buildReportData(payload);
      case "save":
        return await saveReport(payload);
      case "detail":
        return await detailReport(payload);
      case "createShareToken":
        return await createShareToken(payload);
      case "list":
        return await listReports(payload);
      case "remove":
        return await removeReport(payload);
      case "createPdfTask":
        return await createPdfTask(payload);
      case "getPdfTaskStatus":
        return await getPdfTaskStatus(payload);
      default:
        return {
          success: false,
          message: "未知操作"
        };
    }
  } catch (error) {
    console.error("[report] action failed", {
      action,
      message: error && error.message,
      stack: error && error.stack
    });
    return {
      success: false,
      message: (error && error.message) || "报告服务异常，请稍后重试"
    };
  }
};
