const { getProjectDetail, saveProject } = require("../../../services/project");
const { PROJECT_STATUS_OPTIONS } = require("../../../constants/status");
const { markGuideStep } = require("../../../utils/guide");
const { isCoachStep, stopCoach, buildCoachTip } = require("../../../utils/coach");

Page({
  data: {
    projectId: "",
    pageTitle: "新建项目",
    isSaving: false,
    projectStatusOptions: PROJECT_STATUS_OPTIONS,
    projectStatusIndex: 0,
    form: {
      name: "",
      address: "",
      clientName: "",
      clientPhone: "",
      description: "",
      status: "active"
    },
    coachTipVisible: false,
    coachTipTitle: "",
    coachTipDesc: "",
    coachHighlightSave: false,
    coachHighlightName: false,
    coachHighlightAddress: false,
    coachTargetLabel: "项目名称",
    coachActiveTargetLabel: ""
  },
  async onLoad(query) {
    if (query.projectId) {
      this.setData({
        projectId: query.projectId,
        pageTitle: "编辑项目"
      });
      await this.loadDetail(query.projectId);
    }
  },
  onShow() {
    const active = isCoachStep("projectCreateForm") && !this.data.projectId;
    const tip = buildCoachTip("projectCreateForm");
    this.setData({
      coachTipVisible: active,
      coachTipTitle: tip.title,
      coachTipDesc: "先填写高亮输入框，再点击“保存项目”。",
      coachHighlightSave: active,
      coachTargetLabel: "项目名称",
      coachActiveTargetLabel: "项目名称"
    }, () => {
      if (active) {
        this.ensureCoachTargetVisible("项目名称");
      }
    });
    this.updateCoachFormTip();
  },
  updateCoachFormTip() {
    if (!this.data.coachTipVisible) {
      this.setData({
        coachHighlightName: false,
        coachHighlightAddress: false,
        coachTipDesc: "",
        coachActiveTargetLabel: ""
      });
      return;
    }
    const hasName = Boolean((this.data.form.name || "").trim());
    const hasAddress = Boolean((this.data.form.address || "").trim());
    const missing = [];
    if (!hasName) {
      missing.push("项目名称");
    }
    if (!hasAddress) {
      missing.push("项目地址");
    }
    const nextTargetLabel = !hasName ? "项目名称" : (!hasAddress ? "项目地址" : "保存项目");
    const targetChanged = nextTargetLabel !== this.data.coachActiveTargetLabel;
    this.setData({
      coachHighlightName: !hasName,
      coachHighlightAddress: !hasAddress,
      coachTargetLabel: nextTargetLabel,
      coachActiveTargetLabel: nextTargetLabel,
      coachTipDesc: missing.length
        ? `当前缺少：${missing.join("、")}。先补齐，再点击保存。`
        : "很好，必填项已完成。点击「保存项目」继续下一步。"
    }, () => {
      if (targetChanged) {
        this.ensureCoachTargetVisible(nextTargetLabel);
      }
    });
  },
  ensureCoachTargetVisible(targetLabel) {
    const selector = targetLabel === "项目地址"
      ? "#coach-address-target"
      : (targetLabel === "保存项目" ? "#coach-save-target" : "#coach-name-target");
    const query = wx.createSelectorQuery();
    query.select(selector).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((result = []) => {
      const rect = result[0];
      const viewport = result[1];
      if (!rect || !viewport) {
        return;
      }
      const windowHeight = wx.getSystemInfoSync().windowHeight || 0;
      const safeTop = 150;
      const safeBottom = windowHeight - 180;
      let delta = 0;
      if (rect.top < safeTop) {
        delta = rect.top - safeTop - 20;
      } else if (rect.bottom > safeBottom) {
        delta = rect.bottom - safeBottom + 20;
      }
      if (!delta) {
        return;
      }
      wx.pageScrollTo({
        scrollTop: Math.max(0, (viewport.scrollTop || 0) + delta),
        duration: 220
      });
    });
  },
  handleCoachSkip() {
    stopCoach();
    this.setData({
      coachTipVisible: false,
      coachHighlightSave: false
    });
  },
  noop() {},
  async loadDetail(projectId) {
    const result = await getProjectDetail(projectId);
    const projectStatusIndex = PROJECT_STATUS_OPTIONS.findIndex((item) => item.value === (result.project.status || "active"));
    this.setData({
      form: {
        name: result.project.name || "",
        address: result.project.address || "",
        clientName: result.project.clientName || "",
        clientPhone: result.project.clientPhone || "",
        description: result.project.description || "",
        status: result.project.status || "active"
      },
      projectStatusIndex: projectStatusIndex >= 0 ? projectStatusIndex : 0
    });
  },
  handleInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: event.detail.value
    });
    this.updateCoachFormTip();
  },
  handleProjectStatusChange(event) {
    const projectStatusIndex = Number(event.detail.value || 0);
    const selected = PROJECT_STATUS_OPTIONS[projectStatusIndex] || PROJECT_STATUS_OPTIONS[0];
    this.setData({
      projectStatusIndex,
      "form.status": selected.value
    });
  },
  async handleSubmit() {
    if (!this.data.form.name || !this.data.form.address) {
      wx.showToast({
        title: "请填写项目名称和地址",
        icon: "none"
      });
      return;
    }

    // 防重复提交：连点两次会创建两条项目
    if (this.data.isSaving) {
      return;
    }

    this.setData({ isSaving: true });
    wx.showLoading({
      title: "保存中",
      mask: true
    });

    try {
      const saved = await saveProject({
        projectId: this.data.projectId,
        ...this.data.form
      });
      markGuideStep("projectCreated", true);

      wx.hideLoading();
      wx.showToast({
        title: "保存成功",
        icon: "success"
      });

      setTimeout(() => {
        if (isCoachStep("projectCreateForm") && !this.data.projectId && saved && saved._id) {
          stopCoach();
          wx.redirectTo({
            url: `/pages/project/detail/index?projectId=${saved._id}`
          });
          return;
        }
        wx.navigateBack();
      }, 300);
    } catch (error) {
      // 原实现没有 try/catch：保存失败会变成未捕获的 promise rejection，
      // 界面上什么都不显示，用户会以为已经存上了。
      wx.hideLoading();
      console.error("[project-form] save failed", error);
      wx.showModal({
        title: "保存失败",
        content: (error && error.message) || "请检查网络后重试",
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
      this.setData({ isSaving: false });
    }
  }
});
