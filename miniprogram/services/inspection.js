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

function analyzeInspection(payload) {
  return callCloud("ai", {
    action: "analyzeInspection",
    payload
  });
}

function createInspectionTask(payload) {
  return callCloud("ai", {
    action: "createInspectionTask",
    payload
  });
}

function getInspectionTaskStatus(taskId) {
  return callCloud("ai", {
    action: "getInspectionTaskStatus",
    payload: { taskId }
  });
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
