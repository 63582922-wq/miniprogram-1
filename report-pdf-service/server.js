const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { renderReportPdf } = require("./src/render-report-pdf");

const app = express();
const port = process.env.PORT || 3100;
const API_KEY = process.env.PDF_API_KEY || "";
const taskStore = new Map();
let runningTaskId = "";

app.use(express.json({
  limit: "20mb"
}));

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return next();
  }
  const provided = (req.headers["x-api-key"] || req.query.apiKey || "").trim();
  if (provided === API_KEY) {
    return next();
  }
  res.status(401).json({
    success: false,
    message: "API Key 无效或缺失"
  });
}

function summarizeReportPayload(reportPayload = {}) {
  const items = Array.isArray(reportPayload.items) ? reportPayload.items : [];
  let totalImages = 0;
  let totalAnnotatedImages = 0;
  items.forEach((item) => {
    totalImages += Array.isArray(item.images) ? item.images.length : 0;
    totalAnnotatedImages += Array.isArray(item.annotatedImages) ? item.annotatedImages.length : 0;
  });
  return {
    title: reportPayload.title || "",
    itemsCount: items.length,
    totalImages,
    totalAnnotatedImages
  };
}

function createTaskId() {
  return `pdf-task-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
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

function getTaskSnapshot(task) {
  if (!task) {
    return null;
  }
  return {
    taskId: task.taskId,
    status: task.status,
    fileName: task.fileName,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt || 0,
    finishedAt: task.finishedAt || 0,
    errorMessage: task.errorMessage || "",
    summary: task.summary,
    pdfBytes: task.pdfBytes || 0
  };
}

async function renderTaskPdf(task) {
  const startedAt = Date.now();
  task.status = "running";
  task.startedAt = startedAt;
  task.updatedAt = startedAt;
  console.log("[report-pdf-service] task:start", {
    taskId: task.taskId,
    ...task.summary
  });
  try {
    const rawPdfBuffer = await renderReportPdf(task.payload);
    const pdfBuffer = Buffer.isBuffer(rawPdfBuffer) ? rawPdfBuffer : Buffer.from(rawPdfBuffer);
    const tempFilePath = path.join(os.tmpdir(), `${task.taskId}.pdf`);
    await fs.promises.writeFile(tempFilePath, pdfBuffer);
    task.tempFilePath = tempFilePath;
    task.status = "success";
    task.updatedAt = Date.now();
    task.finishedAt = task.updatedAt;
    task.pdfBytes = pdfBuffer.length;
    console.log("[report-pdf-service] task:success", {
      taskId: task.taskId,
      ...task.summary,
      pdfBytes: pdfBuffer.length,
      durationMs: task.finishedAt - startedAt
    });
  } catch (error) {
    task.status = "failed";
    task.updatedAt = Date.now();
    task.finishedAt = task.updatedAt;
    task.errorMessage = error && error.message ? error.message : "Puppeteer PDF 生成失败";
    console.error("[report-pdf-service] task:error", {
      taskId: task.taskId,
      ...task.summary,
      message: task.errorMessage,
      stack: error && error.stack ? error.stack : "",
      durationMs: task.finishedAt - startedAt
    });
  }
}

async function processNextTask() {
  if (runningTaskId) {
    return;
  }
  const nextTask = Array.from(taskStore.values()).find((task) => task.status === "queued");
  if (!nextTask) {
    return;
  }
  runningTaskId = nextTask.taskId;
  try {
    await renderTaskPdf(nextTask);
  } finally {
    runningTaskId = "";
    processNextTask().catch((error) => {
      console.error("[report-pdf-service] task:queue-error", error);
    });
  }
}

function createTask(reportPayload = {}) {
  if (!reportPayload.title || !Array.isArray(reportPayload.items)) {
    const error = new Error("缺少报告标题或问题项数据");
    error.statusCode = 400;
    throw error;
  }
  const taskId = createTaskId();
  const fileName = buildPdfFileName(reportPayload);
  const task = {
    taskId,
    status: "queued",
    payload: reportPayload,
    fileName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    errorMessage: "",
    tempFilePath: "",
    pdfBytes: 0,
    summary: summarizeReportPayload(reportPayload)
  };
  taskStore.set(taskId, task);
  processNextTask().catch((error) => {
    console.error("[report-pdf-service] task:process-error", error);
  });
  return getTaskSnapshot(task);
}

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "report-pdf-service"
  });
});

app.post("/api/report-pdf/generate", requireApiKey, async (req, res) => {
  const startedAt = Date.now();
  try {
    const reportPayload = req.body || {};
    const summary = summarizeReportPayload(reportPayload);
    console.log("[report-pdf-service] generate:start", {
      ...summary,
      contentLength: req.headers["content-length"] || "",
      userAgent: req.headers["user-agent"] || ""
    });
    if (!reportPayload.title || !Array.isArray(reportPayload.items)) {
      res.status(400).json({
        success: false,
        message: "缺少报告标题或问题项数据"
      });
      return;
    }

    const rawPdfBuffer = await renderReportPdf(reportPayload);
    const pdfBuffer = Buffer.isBuffer(rawPdfBuffer) ? rawPdfBuffer : Buffer.from(rawPdfBuffer);
    const fileName = buildPdfFileName(reportPayload);
    console.log("[report-pdf-service] generate:success", {
      ...summary,
      pdfBytes: pdfBuffer.length,
      durationMs: Date.now() - startedAt
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.status(200).send(pdfBuffer);
  } catch (error) {
    console.error("[report-pdf-service] generate:error", {
      message: error && error.message ? error.message : "",
      stack: error && error.stack ? error.stack : "",
      durationMs: Date.now() - startedAt
    });
    res.status(500).json({
      success: false,
      message: error.message || "Puppeteer PDF 生成失败"
    });
  }
});

app.post("/api/report-pdf/tasks", requireApiKey, (req, res) => {
  try {
    const task = createTask(req.body || {});
    res.json({
      success: true,
      data: task
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "创建 PDF 任务失败"
    });
  }
});

app.get("/api/report-pdf/tasks/:taskId", requireApiKey, (req, res) => {
  const task = taskStore.get(req.params.taskId);
  if (!task) {
    res.status(404).json({
      success: false,
      message: "PDF 任务不存在"
    });
    return;
  }
  res.json({
    success: true,
    data: getTaskSnapshot(task)
  });
});

app.get("/api/report-pdf/tasks/:taskId/download", requireApiKey, (req, res) => {
  const task = taskStore.get(req.params.taskId);
  if (!task) {
    res.status(404).json({
      success: false,
      message: "PDF 任务不存在"
    });
    return;
  }
  if (task.status !== "success" || !task.tempFilePath) {
    res.status(409).json({
      success: false,
      message: "PDF 任务尚未完成"
    });
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(task.fileName)}`);
  fs.createReadStream(task.tempFilePath).pipe(res);
});

app.listen(port, () => {
  console.log(`report-pdf-service listening on :${port}`);
});
