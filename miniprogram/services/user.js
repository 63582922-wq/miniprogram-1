const { callCloud } = require("./cloud");

async function loginAndBootstrapUser() {
  return callCloud("auth", {
    action: "initSession"
  });
}

async function getCurrentUser() {
  return callCloud("auth", {
    action: "getCurrentUser"
  });
}

async function updateProfile(payload) {
  return callCloud("auth", {
    action: "updateProfile",
    payload
  });
}

module.exports = {
  loginAndBootstrapUser,
  getCurrentUser,
  updateProfile
};
