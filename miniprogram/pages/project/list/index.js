const { listProjects, deleteProject } = require("../../../services/project");
const { getGuideProgress, isGuideCompleted } = require("../../../utils/guide");
const { startCoach } = require("../../../utils/coach");
const ONBOARDING_SEEN_KEY = "onboardingSeenV1";

Page({
  data: {
    keyword: "",
    projectList: [],
    onboardingCheckedInSession: false
  },
  onShow() {
    if (this.tryShowOnboarding()) {
      return;
    }
    this.loadProjects();
  },
  tryShowOnboarding() {
    if (this.data.onboardingCheckedInSession) {
      return false;
    }
    this.setData({
      onboardingCheckedInSession: true
    });
    const progress = getGuideProgress();
    const guideDone = isGuideCompleted(progress);
    if (guideDone) {
      return false;
    }
    wx.setStorageSync(ONBOARDING_SEEN_KEY, true);
    if (progress.settingsCompleted) {
      startCoach("projectCreateForm");
      wx.navigateTo({
        url: "/pages/project/form/index"
      });
      return true;
    }
    startCoach("settingsSave");
    wx.navigateTo({
      url: "/pages/settings/index"
    });
    return true;
  },
  async loadProjects() {
    try {
      const result = await listProjects({
        keyword: this.data.keyword
      });
      this.setData({
        projectList: result.list || []
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    }
  },
  handleKeywordInput(event) {
    this.setData({
      keyword: event.detail.value
    });
  },
  handleSearch() {
    this.loadProjects();
  },
  goCreate() {
    wx.navigateTo({
      url: "/pages/project/form/index"
    });
  },
  openDetail(event) {
    const { _id } = event.detail;
    wx.navigateTo({
      url: `/pages/project/detail/index?projectId=${_id}`
    });
  },
  async handleProjectLongPress(event) {
    const projectId = event.currentTarget.dataset.projectId;
    const projectName = event.currentTarget.dataset.projectName || "该项目";
    if (!projectId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除项目"],
          itemColor: "#FF3B30",
          success: resolve,
          fail: reject
        });
      });

      if (!actionResult || actionResult.tapIndex !== 0) {
        return;
      }

      const confirmResult = await new Promise((resolve) => {
        wx.showModal({
          title: "删除项目",
          content: `确定删除“${projectName}”吗？删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteProject(projectId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadProjects();
    } catch (error) {
      if (error && /cancel/i.test(error.errMsg || "")) {
        return;
      }
      wx.showToast({
        title: error.message || "删除失败",
        icon: "none"
      });
    }
  }
});
