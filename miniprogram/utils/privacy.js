const PRIVACY_AUTHORIZE_TIMEOUT_MS = 120000;
const GET_PRIVACY_SETTING_TIMEOUT_MS = 6000;
const privacyHosts = [];
let listenerInstalled = false;
function registerPrivacyHost(host) {privacyHosts.push(host);return ()=>{const i=privacyHosts.indexOf(host);if(i>=0)privacyHosts.splice(i,1);};}

function requirePrivacyAuthorizeWithTimeout() {
  return new Promise((resolve, reject) => {
    if (typeof wx.requirePrivacyAuthorize !== "function") {
      reject(new Error("当前微信版本不支持隐私授权，请更新微信或使用文字记录"));
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
      reject(new Error("隐私状态查询超时，请重试"));
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
  const host = [...privacyHosts].reverse().find(h=>h.privacyActive);
  if(host)host.requestPrivacy(resolve);
  else resolve({event:"disagree"});
}

function setupPrivacyListener() {
  if (listenerInstalled || typeof wx.onNeedPrivacyAuthorization !== "function") {
    return;
  }
  wx.onNeedPrivacyAuthorization(handlePrivacyAuthorization);
  listenerInstalled=true;
}

module.exports = {
  requirePrivacy,
  setupPrivacyListener, registerPrivacyHost
};
