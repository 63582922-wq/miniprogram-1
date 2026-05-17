const PRIVACY_AUTHORIZE_TIMEOUT_MS = 12000;
const GET_PRIVACY_SETTING_TIMEOUT_MS = 6000;

function requirePrivacyAuthorizeWithTimeout() {
  return new Promise((resolve, reject) => {
    if (typeof wx.requirePrivacyAuthorize !== "function") {
      resolve();
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject({ errMsg: "requirePrivacyAuthorize:timeout" });
    }, PRIVACY_AUTHORIZE_TIMEOUT_MS);

    const settle = (fn) => (arg) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    wx.requirePrivacyAuthorize({
      success: settle(resolve),
      fail: settle(reject)
    });
  });
}

function requirePrivacy() {
  return new Promise((resolve, reject) => {
    const runAuthorize = () => {
      requirePrivacyAuthorizeWithTimeout().then(resolve).catch(reject);
    };

    if (typeof wx.getPrivacySetting !== "function") {
      runAuthorize();
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    }, GET_PRIVACY_SETTING_TIMEOUT_MS);

    wx.getPrivacySetting({
      success(res) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (res && res.needAuthorization === false) {
          resolve();
          return;
        }
        runAuthorize();
      },
      fail() {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        runAuthorize();
      }
    });
  });
}

function handlePrivacyAuthorization(resolve) {
  wx.showModal({
    title: "隐私保护提示",
    content: "在使用相机、相册、麦克风等功能前，需要你同意《隐私保护指引》。你可以点击「查看」了解详情。",
    confirmText: "同意并继续",
    cancelText: "查看指引",
    success(res) {
      if (res.confirm) {
        resolve({ event: "agree" });
      } else {
        wx.navigateTo({
          url: "/pages/legal/index"
        });
        resolve({ event: "disagree" });
      }
    }
  });
}

function setupPrivacyListener() {
  if (typeof wx.onNeedPrivacyAuthorization !== "function") {
    return;
  }
  wx.onNeedPrivacyAuthorization(handlePrivacyAuthorization);
}

module.exports = {
  requirePrivacy,
  setupPrivacyListener
};
