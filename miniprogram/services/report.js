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

/**
 * 删除报告。
 *
 * @param {string} reportId
 * @param {boolean} withRecord 是否连这次巡查记录（含照片）一起删。
 *   报告只是巡查的一次「发布」，照片存在 inspections 里，删报告默认不动底稿——
 *   所以删对了还能重新生成报告。要不要连底稿一起销毁，交给用户当场决定。
 */
function deleteReport(reportId, withRecord) {
  return callCloud("report", {
    action: "remove",
    payload: { reportId, withRecord: withRecord === true }
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
