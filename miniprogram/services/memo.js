const { callCloud } = require("./cloud");

function listMemos(payload = {}) {
  return callCloud("memo", {
    action: "list",
    payload
  });
}

function saveMemo(payload) {
  return callCloud("memo", {
    action: payload.memoId ? "update" : "create",
    payload
  });
}

function getMemoDetail(memoId) {
  return callCloud("memo", {
    action: "detail",
    payload: { memoId }
  });
}

function deleteMemo(memoId) {
  return callCloud("memo", {
    action: "delete",
    payload: { memoId }
  });
}

module.exports = {
  listMemos,
  saveMemo,
  getMemoDetail,
  deleteMemo
};
