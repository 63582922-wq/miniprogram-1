const COACH_STATE_KEY = "onboardingCoachStateV1";
const COACH_STEPS = [
  "settingsSave",
  "projectCreateForm"
];

const COACH_META = {
  settingsSave: {
    pageName: "设置页",
    stepName: "基础设置",
    targetLabel: "保存设置"
  },
  projectCreateForm: {
    pageName: "新建项目页",
    stepName: "创建项目",
    targetLabel: "保存项目"
  }
};

function getCoachState() {
  const state = wx.getStorageSync(COACH_STATE_KEY) || {};
  const step = COACH_STEPS.includes(state.step) ? state.step : "";
  return {
    active: Boolean(state.active && step),
    step
  };
}

function setCoachState(nextState = {}) {
  const merged = {
    ...getCoachState(),
    ...nextState
  };
  wx.setStorageSync(COACH_STATE_KEY, merged);
  return merged;
}

function startCoach(step) {
  return setCoachState({
    active: true,
    step: step || ""
  });
}

function moveCoach(step) {
  return setCoachState({
    active: true,
    step: step || ""
  });
}

function stopCoach() {
  return setCoachState({
    active: false,
    step: ""
  });
}

function isCoachStep(step) {
  const state = getCoachState();
  return Boolean(state.active && state.step === step);
}

function getCoachStepIndex(step) {
  return COACH_STEPS.indexOf(step);
}

function getNextCoachStep(step) {
  const index = getCoachStepIndex(step);
  if (index < 0 || index >= COACH_STEPS.length - 1) {
    return "";
  }
  return COACH_STEPS[index + 1];
}

function getPrevCoachStep(step) {
  const index = getCoachStepIndex(step);
  if (index <= 0) {
    return "";
  }
  return COACH_STEPS[index - 1];
}

function getCoachStepProgress(step) {
  const index = getCoachStepIndex(step);
  if (index < 0) {
    return {
      current: 0,
      total: COACH_STEPS.length
    };
  }
  return {
    current: index + 1,
    total: COACH_STEPS.length
  };
}

function getCoachMeta(step) {
  return COACH_META[step] || {
    pageName: "当前页面",
    stepName: "当前步骤",
    targetLabel: "目标按钮"
  };
}

function buildCoachTip(step, options = {}) {
  const meta = getCoachMeta(step);
  const progress = getCoachStepProgress(step);
  const nextStep = getNextCoachStep(step);
  const nextMeta = nextStep ? getCoachMeta(nextStep) : null;
  const targetLabel = options.targetLabel || meta.targetLabel;
  const dynamicGoal = options.dynamicGoal || meta.stepName;
  const title = `新手引导（${progress.current}/${progress.total}）`;
  const arrow = `请点击「${targetLabel}」`;
  const desc = options.customDesc
    || `你正在${meta.pageName}完成「${dynamicGoal}」。${nextMeta ? `完成后将进入「${nextMeta.stepName}」。` : "完成后即结束新手流程。"}${options.tailHint ? ` ${options.tailHint}` : ""}`;
  return {
    title,
    arrow,
    desc
  };
}

module.exports = {
  getCoachState,
  startCoach,
  moveCoach,
  stopCoach,
  isCoachStep,
  getNextCoachStep,
  getPrevCoachStep,
  getCoachStepProgress,
  getCoachMeta,
  buildCoachTip
};
