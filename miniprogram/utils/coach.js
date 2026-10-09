const COACH_STATE_KEY = "onboardingCoachStateV1";

/**
 * 读写本机存储。
 *
 * 这两个 utils 会被 require 进页面模块，而页面测试是在隔离 vm 里跑的：
 * 注入的 wx 只存在于页面作用域，被 require 的模块拿不到，直接 `wx.getStorageSync`
 * 会抛 ReferenceError，把整页测试带崩。
 * 引导只是锦上添花，读不到存储就当「没有引导」——绝不能因为它让页面挂掉。
 */
function readCoachStorage(key) {
  try {
    if (typeof wx === "undefined" || typeof wx.getStorageSync !== "function") return undefined;
    return wx.getStorageSync(key);
  } catch (_error) {
    return undefined;
  }
}

function writeCoachStorage(key, value) {
  try {
    if (typeof wx === "undefined" || typeof wx.setStorageSync !== "function") return;
    wx.setStorageSync(key, value);
  } catch (_error) {}
}



/**
 * 新手引导的步骤表——**按现场实际顺序**，不是按功能模块。
 *
 * 这是一次「渐进式高亮」引导，不是幻灯片：每一步都等用户真的做完了动作
 * 才进入下一步（建完项目才有项目详情可指）。所以步骤之间是事件驱动推进的，
 * 由各页面在动作成功后调用 moveCoach()。
 *
 * 每一步都在某个页面上高亮一个真实按钮，用户点的是按钮本身。
 */
const COACH_STEPS = [
  "settingsSave",
  "projectCreateForm",
  "projectDetailStart",
  "capturePickPhoto",
  "captureAnnotate",
  "captureVoice",
  "captureContinue",
  "reviewPublish",
  "reportShare"
];

const COACH_META = {
  settingsSave: {
    pageName: "设置页",
    stepName: "填一次资料",
    targetLabel: "保存设置",
    desc: "公司名称、电话、地址、Logo 和巡查人信息会自动带进之后每一份报告的抬头。只做这一次。"
  },
  projectCreateForm: {
    pageName: "新建项目页",
    stepName: "建第一个项目",
    targetLabel: "保存项目",
    desc: "一个工地一个项目。项目是归档主线——之后每次巡查和每份报告都挂在它下面。"
  },
  projectDetailStart: {
    pageName: "项目详情页",
    stepName: "开始记录现场",
    targetLabel: "开始现场记录",
    desc: "从这里进入拍照。同一个项目可以记很多次，比如水电一次、瓦工一次。"
  },
  capturePickPhoto: {
    pageName: "现场记录页",
    stepName: "先拍第一张照片",
    targetLabel: "添加照片",
    desc: "拍照或从相册选。建议横向拍，竖图也支持。一个项目可以记很多次。"
  },
  captureAnnotate: {
    pageName: "现场记录页",
    stepName: "在照片上圈出问题",
    targetLabel: "标注",
    desc: "点「标注」在照片上框选或点选，系统会自动编号。报告里的编号与这里一一对应——只在照片下写字、没有圈位置，报告里就没有编号可看。"
  },
  captureVoice: {
    pageName: "现场记录页",
    stepName: "写说明或按住说话",
    targetLabel: "按住说话",
    desc: "打字，或按住输入框右边的麦克风说话，松开自动转成文字。旁边的「AI识图」是可选辅助，识别结果要你核对确认才会写进报告。"
  },
  captureContinue: {
    pageName: "现场记录页",
    stepName: "进入人工核对",
    targetLabel: "整理说明并核对",
    desc: "照片和说明都记好后点这里，进入逐条核对。"
  },
  reviewPublish: {
    pageName: "人工核对页",
    stepName: "确认并生成报告",
    targetLabel: "确认内容并生成报告",
    desc: "核对每条问题的区域、分类、责任方和等级。有标注却没写问题的照片会被拦下来，避免报告缺内容就发出去。"
  },
  reportShare: {
    pageName: "报告页",
    stepName: "转发给业主",
    targetLabel: "转发这份报告",
    desc: "转发出去的是只读报告，对方不用登录、也看不到你其他任何记录。分享链接随时可以撤销。"
  }
};

function getCoachState() {
  const state = readCoachStorage(COACH_STATE_KEY) || {};
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
  writeCoachStorage(COACH_STATE_KEY, merged);
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
    targetLabel: "目标按钮",
    desc: ""
  };
}

function buildCoachTip(step, options = {}) {
  const meta = getCoachMeta(step);
  const progress = getCoachStepProgress(step);
  const nextStep = getNextCoachStep(step);
  const nextMeta = nextStep ? getCoachMeta(nextStep) : null;
  const targetLabel = options.targetLabel || meta.targetLabel;
  const dynamicGoal = options.dynamicGoal || meta.stepName;
  return {
    title: options.customTitle || dynamicGoal,
    arrow: `请点击「${targetLabel}」`,
    stepText: `新手引导 ${progress.current}/${progress.total}`,
    desc: options.customDesc
      || meta.desc
      || `你正在${meta.pageName}完成「${dynamicGoal}」。${nextMeta ? `完成后将进入「${nextMeta.stepName}」。` : "完成后即结束新手流程。"}`
  };
}

module.exports = {
  COACH_STEPS,
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
