const { callCloud } = require("./cloud");

function analyzeChat(payload) {
  return callCloud("chat", {
    action: "analyze",
    payload
  });
}

function listChatAnalysis(payload = {}) {
  return callCloud("chat", {
    action: "list",
    payload
  });
}

function getChatAnalysisDetail(payload = {}) {
  return callCloud("chat", {
    action: "detail",
    payload
  });
}

module.exports = {
  analyzeChat,
  listChatAnalysis,
  getChatAnalysisDetail
};
