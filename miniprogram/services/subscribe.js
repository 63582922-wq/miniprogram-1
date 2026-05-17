const { callCloud } = require("./cloud");

function saveSubscription(payload) {
  return callCloud("subscribe", {
    action: "save",
    payload
  });
}

module.exports = {
  saveSubscription
};
