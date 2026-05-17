const { callCloud, uploadToCloud } = require("./cloud");

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
  return uploadToCloud(filePath, `reports/${Date.now()}-${fileName}`);
}

function generateReportPdf(payload) {
  return callCloud("report", {
    action: "generatePdf",
    payload
  });
}

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
  generateReportPdf,
  createReportPdfTask,
  getReportPdfTaskStatus,
  deleteReport
};
