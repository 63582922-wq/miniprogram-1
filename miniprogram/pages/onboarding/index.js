const { listProjects } = require("../../services/project");
const { getSettings } = require("../../services/settings");
const { getCurrentUser } = require("../../services/user");
const { getGuideProgress, markGuideStep, isGuideCompleted } = require("../../utils/guide");
const { startCoach, stopCoach } = require("../../utils/coach");

const ONBOARDING_SEEN_KEY = "onboardingSeenV1";
const ONBOARDING_FIRST_TIP_SHOWN_KEY = "onboardingFirstTipShownV1";
const ONBOARDING_IGNORE_HISTORY_KEY = "onboardingIgnoreHistoryV1";

function toViewStep(step = {}, completed = false) {
  return {
    ...step,
    completed,
    statusText: completed ? "已完成" : "未完成",
    showAction: !completed,
    cardClass: completed ? "card onboarding-step onboarding-step--done" : "card onboarding-step"
  };
}

Page({
  data: {
    loading: true,
    completedCount: 0,
    steps: [
      {
        key: "settingsCompleted",
        title: "第一步：完成基础设置",
        desc: "先填写巡查人信息与公司信息，后续报告会自动带入这些内容。",
        actionText: "去设置",
        tipTitle: "为什么先做设置",
        tipContent: "基础设置通常只需做一次。你填写的 Logo、公司名称、公司地址、巡查人、联系方式等信息，会自动带入后续报告。"
      },
      {
        key: "projectCreated",
        title: "第二步：创建首个项目",
        desc: "创建第一个项目后，即可按你的业务节奏开始巡查和生成报告。",
        actionText: "去创建项目",
        tipTitle: "为什么先建项目",
        tipContent: "项目是数据归档主线。创建首个项目后，后续巡查和报告会自动归档。"
      }
    ],
    tipVisible: false,
    tipTitle: "",
    tipContent: ""
  },
  onShow() {
    this.refreshGuideState();
  },
  handleBackTap() {
    this.finishAndExit();
  },
  async refreshGuideState() {
    this.setData({
      loading: true
    });
    const ignoreHistory = Boolean(wx.getStorageSync(ONBOARDING_IGNORE_HISTORY_KEY));
    const progress = getGuideProgress();
    let settingsDone = progress.settingsCompleted;

    try {
      const [settings, userInfo] = await Promise.all([
        getSettings(),
        getCurrentUser()
      ]);
      if (!ignoreHistory) {
        const hasInspectorPhone = Boolean((userInfo && userInfo.phone) || "");
        const hasCompanyProfile = Boolean(
          (settings && settings.companyName)
          || (settings && settings.companyPhone)
          || (settings && settings.companyAddress)
          || (settings && settings.logoFileId)
        );
        settingsDone = Boolean(settingsDone || hasInspectorPhone || hasCompanyProfile);
      }
    } catch (_error) {}

    let hasProject = progress.projectCreated;
    try {
      const projectResult = await listProjects({
        keyword: ""
      });
      if (!ignoreHistory) {
        hasProject = Boolean(hasProject || (projectResult.list || []).length);
      }
    } catch (_error) {}

    markGuideStep("settingsCompleted", settingsDone);
    markGuideStep("projectCreated", hasProject);

    const latest = getGuideProgress();
    const steps = this.data.steps.map((item) => toViewStep(item, Boolean(latest[item.key])));
    this.setData({
      steps,
      loading: false,
      completedCount: steps.filter((item) => item.completed).length
    });
    this.tryAutoShowFirstTip();
  },
  tryAutoShowFirstTip() {
    if (wx.getStorageSync(ONBOARDING_FIRST_TIP_SHOWN_KEY)) {
      return;
    }
    const firstStep = (this.data.steps || [])[0];
    if (!firstStep) {
      return;
    }
    wx.setStorageSync(ONBOARDING_FIRST_TIP_SHOWN_KEY, true);
    this.setData({
      tipVisible: true,
      tipTitle: firstStep.tipTitle,
      tipContent: firstStep.tipContent
    });
  },
  handleStepAction(event) {
    const stepKey = event.currentTarget.dataset.step;
    if (stepKey === "settingsCompleted") {
      startCoach("settingsSave");
      wx.navigateTo({
        url: "/pages/settings/index"
      });
      return;
    }
    if (stepKey === "projectCreated") {
      startCoach("projectCreateForm");
      wx.navigateTo({
        url: "/pages/project/form/index"
      });
    }
  },
  handleStepTip(event) {
    const stepKey = event.currentTarget.dataset.step;
    const step = (this.data.steps || []).find((item) => item.key === stepKey);
    if (!step) {
      return;
    }
    this.setData({
      tipVisible: true,
      tipTitle: step.tipTitle || "步骤说明",
      tipContent: step.tipContent || ""
    });
  },
  closeStepTip() {
    this.setData({
      tipVisible: false,
      tipTitle: "",
      tipContent: ""
    });
  },
  noop() {},
  finishAndExit() {
    wx.setStorageSync(ONBOARDING_SEEN_KEY, true);
    if (isGuideCompleted(getGuideProgress())) {
      stopCoach();
    }
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1
      });
      return;
    }
    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  handleCompleteTap() {
    if (!isGuideCompleted(getGuideProgress())) {
      wx.showToast({
        title: "先完成设置和首个项目",
        icon: "none"
      });
      return;
    }
    this.finishAndExit();
  }
});
