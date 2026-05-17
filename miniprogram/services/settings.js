const { callCloud } = require("./cloud");

function getSettings() {
  return callCloud("settings", {
    action: "detail"
  });
}

function saveSettings(payload) {
  return callCloud("settings", {
    action: "save",
    payload
  });
}

module.exports = {
  getSettings,
  saveSettings
};
