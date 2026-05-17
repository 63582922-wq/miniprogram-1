const GUIDE_PROGRESS_KEY = "onboardingGuideProgressV1";

function getDefaultProgress() {
  return {
    settingsCompleted: false,
    projectCreated: false
  };
}

function getGuideProgress() {
  const stored = wx.getStorageSync(GUIDE_PROGRESS_KEY) || {};
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
  wx.setStorageSync(GUIDE_PROGRESS_KEY, normalized);
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
