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

async function submitPrivacyRequest(payload) {
  return callCloud("auth", {action:"submitPrivacyRequest",payload});
}

async function listPrivacyRequests() {
  return callCloud("auth", {action:"listPrivacyRequests"});
}

module.exports = {
  loginAndBootstrapUser,
  getCurrentUser,
  updateProfile,
  submitPrivacyRequest,
  listPrivacyRequests
};
