const { callCloud } = require("./cloud");

function listInspections(payload = {}) {
  return callCloud("inspection", {
    action: "list",
    payload
  });
}

function createInspection(payload) {
  return callCloud("inspection", {
    action: "create",
    payload
  });
}

function getInspectionDetail(inspectionId) {
  return callCloud("inspection", {
    action: "detail",
    payload: { inspectionId }
  });
}

/**
 * AI 相关的三个调用都关闭超时重试。
 *
 * 它们本身要跑几十秒、服务端也已经用满自己的时间预算（异步任务一轮最多 45 秒），
 * 重试只会让用户多等一轮 —— 而超时那次模型已经做完的工作等于白做。
 */
const AI_CALL_OPTIONS = {
  retryOnTimeout: false,
  timeout: 60000
};

function analyzeInspection(payload) {
  return callCloud("ai", {
    action: "analyzeInspection",
    payload
  }, AI_CALL_OPTIONS);
}

function createInspectionTask(payload) {
  return callCloud("ai", {
    action: "createInspectionTask",
    payload
  }, AI_CALL_OPTIONS);
}

function getInspectionTaskStatus(taskId, advance = false) {
  return callCloud("ai", {
    action: advance ? "advanceInspectionTask" : "readInspectionTaskStatus",
    payload: { taskId }
  }, AI_CALL_OPTIONS);
}

function confirmInspection(payload) {
  return callCloud("inspection", {
    action: "confirm",
    payload
  });
}

function deleteInspection(inspectionId) {
  return callCloud("inspection", {
    action: "remove",
    payload: { inspectionId }
  });
}

module.exports = {
  listInspections,
  createInspection,
  getInspectionDetail,
  analyzeInspection,
  createInspectionTask,
  getInspectionTaskStatus,
  confirmInspection,
  deleteInspection
};
