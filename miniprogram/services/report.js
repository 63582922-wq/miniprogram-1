const { callCloud, uploadUserFile } = require("./cloud");

function getReportDetail(reportId, inspectionId, shareToken) {
  return callCloud("report", {
    action: "detail",
    payload: { reportId, inspectionId, shareToken }
  });
}

/**
 * 取报告的分享 token（首次调用会生成）。
 * 转发时把它带在路径上，收件人无需账号权限即可只读查看。
 */
function createReportShareToken(reportId, rotate = false) {
  return callCloud("report", {
    action: "createShareToken",
    payload: { reportId, rotate }
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

function deleteReport(reportId) {
  return callCloud("report", {
    action: "remove",
    payload: { reportId }
  });
}

module.exports = {
  revokeReportShareToken: (reportId) => callCloud("report", {action:"revokeShareToken",payload:{reportId}}),
  getReportDetail,
  createReportShareToken,
  buildReportData,
  saveReport,
  listReports,
  uploadReportFile,
  deleteReport
};
