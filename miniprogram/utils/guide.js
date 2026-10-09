const GUIDE_PROGRESS_KEY = "onboardingGuideProgressV1";

/**
 * 读写本机存储。
 *
 * 这两个 utils 会被 require 进页面模块，而页面测试是在隔离 vm 里跑的：
 * 注入的 wx 只存在于页面作用域，被 require 的模块拿不到，直接 `wx.getStorageSync`
 * 会抛 ReferenceError，把整页测试带崩。
 * 引导进度同样是锦上添花，读不到存储就当「没有引导」——绝不能因为它让页面挂掉。
 */
function readGuideStorage(key) {
  try {
    if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return undefined;
    return wx.getStorageSync(key);
  } catch (_error) {
    return undefined;
  }
}

function writeGuideStorage(key, value) {
  try {
    if (typeof wx === "undefined" || typeof wx.setStorageSync !== "function") return;
    wx.setStorageSync(key, value);
  } catch (_error) {}
}



function getDefaultProgress() {
  return {
    settingsCompleted: false,
    projectCreated: false
  };
}

function getGuideProgress() {
  const stored = readGuideStorage(GUIDE_PROGRESS_KEY) || {};
  return {
    ...getDefaultProgress(),
    ...stored
  };
}

function setGuideProgress(progress = {}) {
  const normalized = {
    ...getDefaultProgress(),
    ...progress
  };
  writeGuideStorage(GUIDE_PROGRESS_KEY, normalized);
  return normalized;
}

function markGuideStep(stepKey, completed = true) {
  const current = getGuideProgress();
  current[stepKey] = Boolean(completed);
  return setGuideProgress(current);
}

function isGuideCompleted(progress = getGuideProgress()) {
  return Boolean(
    progress.settingsCompleted
    && progress.projectCreated
  );
}

module.exports = {
  getGuideProgress,
  markGuideStep,
  isGuideCompleted
};
