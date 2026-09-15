const { callCloud, uploadUserFile } = require("./cloud");

function getReportDetail(reportId, inspectionId) {
  return callCloud("report", {
    action: "detail",
    payload: { reportId, inspectionId }
  });
}

function buildReportData(payload) {
  return callCloud("report", {
    action: "build",
    payload
  });
}

function saveReport(payload) {
  return callCloud("report", {
    action: "save",
    payload
  });
}

function listReports(payload = {}) {
  return callCloud("report", {
    action: "list",
    payload
  });
}

function uploadReportFile(filePath, fileName) {
  return uploadUserFile(filePath, "reports", fileName);
}

// generateReportPdf 已移除：对应的云端 action 因无鉴权且可被客户端指定请求路径而下线。
// 出图统一走 createReportPdfTask + getReportPdfTaskStatus（两侧都有归属校验）。

function createReportPdfTask(payload) {
  return callCloud("report", {
    action: "createPdfTask",
    payload
  });
}

function getReportPdfTaskStatus(payload) {
  return callCloud("report", {
    action: "getPdfTaskStatus",
    payload
  });
}

function deleteReport(reportId) {
  return callCloud("report", {
    action: "remove",
    payload: { reportId }
  });
}

module.exports = {
  getReportDetail,
  buildReportData,
  saveReport,
  listReports,
  uploadReportFile,
  createReportPdfTask,
  getReportPdfTaskStatus,
  deleteReport
};
