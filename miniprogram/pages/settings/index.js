const { getWindowInfo } = require("../../utils/system");
const { getSettings, saveSettings } = require("../../services/settings");
const { uploadUserFile } = require("../../services/cloud");
const { getCurrentUser, updateProfile } = require("../../services/user");
const { markGuideStep } = require("../../utils/guide");
const { isCoachStep, moveCoach, stopCoach, buildCoachTip } = require("../../utils/coach");

const DEFAULT_PDF_SERVICE_URL = "https://pdf.haolizhiguan.cn";

function normalizePdfServiceUrl(value) {
  const candidate = `${value || ""}`
    .trim()
    .replace(/^`+|`+$/g, "");
  if (!candidate) {
    return DEFAULT_PDF_SERVICE_URL;
  }
  if (candidate === DEFAULT_PDF_SERVICE_URL) {
    return candidate;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}/.test(candidate) || candidate.startsWith("http://")) {
    return DEFAULT_PDF_SERVICE_URL;
  }
  return candidate;
}

function getUploadExtension(filePath = "") {
  const match = filePath.toLowerCase().match(/\.([a-z0-9]+)(?:\?|$)/);
  const ext = match ? match[1] : "png";
  const supported = ["png", "jpg", "jpeg", "webp"];
  return supported.includes(ext) ? ext : "png";
}

Page({
  data: {
    form: {
      inspectorName: "",
      inspectorPhone: "",
      companyName: "",
      companyPhone: "",
      companyAddress: "",
      logoFileId: "",
      logoPreview: "",
      reportTemplate: "default",
      reportPdfEngine: "puppeteer",
      reportPdfServiceUrl: DEFAULT_PDF_SERVICE_URL
    },
    isSaving: false,
    coachTipVisible: false,
    coachTipTitle: "",
    coachTipDesc: "",
    coachHighlightSave: false,
    coachTargetLabel: "保存设置",
    editingField: "",
    editModalTitle: "",
    editModalLabel1: "",
    editModalLabel2: "",
    editModalLabel3: "",
    editModalPlaceholder1: "",
    editModalPlaceholder2: "",
    editModalPlaceholder3: "",
    editModalValue1: "",
    editModalValue2: "",
    editModalValue3: ""
  },
  onShow() {
    this.loadSettings();
    this.syncCoachTip();
  },
  syncCoachTip() {
    const active = isCoachStep("settingsSave");
    const tip = buildCoachTip("settingsSave", {
      tailHint: "基础信息会自动带入后续 PDF 报告。"
    });
    this.setData({
      coachTipVisible: active,
      coachTipTitle: tip.title,
      coachTipDesc: "请点击底部高亮按钮「保存设置」。",
      coachHighlightSave: active,
      coachTargetLabel: "保存设置"
    }, () => {
      if (active) {
        this.ensureCoachTargetVisible();
      }
    });
  },
  ensureCoachTargetVisible() {
    const query = wx.createSelectorQuery();
    query.select("#coach-save-target").boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec((result = []) => {
      const rect = result[0];
      const viewport = result[1];
      if (!rect || !viewport) {
        return;
      }
      const windowHeight = getWindowInfo().windowHeight || 0;
      const safeBottom = windowHeight - 180;
      if (rect.bottom <= safeBottom) {
        return;
      }
      const scrollTop = Math.max(0, (viewport.scrollTop || 0) + (rect.bottom - safeBottom) + 20);
      wx.pageScrollTo({
        scrollTop,
        duration: 220
      });
    });
  },
  handleCoachSkip() {
    stopCoach();
    this.syncCoachTip();
  },
  noop() {},
  handleBackTap() {
    wx.navigateBack({
      delta: 1
    });
  },
  openOnboarding() {
    wx.navigateTo({
      url: "/pages/onboarding/index?source=settings"
    });
  },
  openLegalPage() {
    wx.navigateTo({
      url: "/pages/legal/index"
    });
  },
  openInspectorInfo() {
    this.setData({
      editingField: "inspector",
      editModalTitle: "巡查人信息",
      editModalLabel1: "巡查人名称",
      editModalLabel2: "联系电话",
      editModalLabel3: "",
      editModalPlaceholder1: "填写巡查人名称",
      editModalPlaceholder2: "填写巡查人联系电话",
      editModalPlaceholder3: "",
      editModalValue1: this.data.form.inspectorName,
      editModalValue2: this.data.form.inspectorPhone,
      editModalValue3: ""
    });
  },
  openCompanyInfo() {
    this.setData({
      editingField: "company",
      editModalTitle: "公司信息",
      editModalLabel1: "公司名称",
      editModalLabel2: "联系电话",
      editModalLabel3: "公司地址",
      editModalPlaceholder1: "填写公司名称",
      editModalPlaceholder2: "填写公司联系电话",
      editModalPlaceholder3: "填写公司地址",
      editModalValue1: this.data.form.companyName,
      editModalValue2: this.data.form.companyPhone,
      editModalValue3: this.data.form.companyAddress
    });
  },
  handleModalInput1(e) {
    this.setData({ editModalValue1: e.detail.value });
  },
  handleModalInput2(e) {
    this.setData({ editModalValue2: e.detail.value });
  },
  handleModalInput3(e) {
    this.setData({ editModalValue3: e.detail.value });
  },
  closeEditModal() {
    this.setData({ editingField: "" });
  },
  confirmEditModal() {
    const field = this.data.editingField;
    if (field === "inspector") {
      this.setData({
        "form.inspectorName": this.data.editModalValue1,
        "form.inspectorPhone": this.data.editModalValue2,
        editingField: ""
      });
    } else if (field === "company") {
      this.setData({
        "form.companyName": this.data.editModalValue1,
        "form.companyPhone": this.data.editModalValue2,
        "form.companyAddress": this.data.editModalValue3,
        editingField: ""
      });
    }
  },
  async loadSettings() {
    try {
      const [result, userInfo] = await Promise.all([
        getSettings(),
        getCurrentUser()
      ]);
      this.setData({
        form: {
          inspectorName: (userInfo && userInfo.nickname) || "",
          inspectorPhone: (userInfo && userInfo.phone) || "",
          companyName: (result && result.companyName) || "",
          companyPhone: (result && result.companyPhone) || "",
          companyAddress: (result && result.companyAddress) || "",
          logoFileId: (result && result.logoFileId) || "",
          logoPreview: (result && result.logoFileId) || "",
          reportTemplate: (result && result.reportTemplate) || "default",
          reportPdfEngine: "puppeteer",
          reportPdfServiceUrl: normalizePdfServiceUrl(result && result.reportPdfServiceUrl)
        }
      });
    } catch (error) {
      this.setData({
        form: {
          inspectorName: "",
          inspectorPhone: "",
          companyName: "",
          companyPhone: "",
          companyAddress: "",
          logoFileId: "",
          logoPreview: "",
          reportTemplate: "default",
          reportPdfEngine: "puppeteer",
          reportPdfServiceUrl: DEFAULT_PDF_SERVICE_URL
        }
      });
      wx.showToast({
        title: "设置加载失败",
        icon: "none"
      });
    }
  },
  handleInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: event.detail.value
    });
  },
  async handleLogoChange(event) {
    const filePath = event.detail;
    const ext = getUploadExtension(filePath);

    wx.showLoading({
      title: "上传中",
      mask: true
    });

    try {
      const fileId = await uploadUserFile(filePath, "logos", `logo.${ext}`);
      this.setData({
        "form.logoFileId": fileId,
        "form.logoPreview": filePath
      });
      wx.hideLoading();
    } catch (error) {
      // 原实现没有 try/catch，上传失败时 Logo 区域毫无变化，用户不知道为什么
      wx.hideLoading();
      console.error("[settings] logo upload failed", error);
      wx.showModal({
        title: "Logo 上传失败",
        content: (error && error.message) || "请检查网络后重试",
        showCancel: false,
        confirmText: "知道了"
      });
    }
  },
  async handleSubmit() {
    if (this.data.isSaving) {
      return;
    }
    const inspectorName = (this.data.form.inspectorName || "").trim();
    const inspectorPhone = (this.data.form.inspectorPhone || "").trim();
    if (!inspectorName) {
      wx.showToast({
        title: "请填写巡查人名称",
        icon: "none"
      });
      return;
    }
    if (inspectorPhone && !/^[0-9+\-\s]{6,24}$/.test(inspectorPhone)) {
      wx.showToast({
        title: "联系电话格式不正确",
        icon: "none"
      });
      return;
    }
    this.setData({
      isSaving: true
    });
    try {
      await saveSettings({
        companyName: this.data.form.companyName,
        companyPhone: this.data.form.companyPhone,
        companyAddress: this.data.form.companyAddress,
        logoFileId: this.data.form.logoFileId,
        reportTemplate: this.data.form.reportTemplate,
        reportPdfEngine: "puppeteer",
        reportPdfServiceUrl: normalizePdfServiceUrl(this.data.form.reportPdfServiceUrl)
      });
      await updateProfile({
        nickname: inspectorName,
        phone: inspectorPhone
      });
      markGuideStep("settingsCompleted", true);

      wx.showToast({
        title: "设置已保存",
        icon: "success"
      });
      setTimeout(() => {
        if (isCoachStep("settingsSave")) {
          moveCoach("projectCreateForm");
          wx.redirectTo({
            url: "/pages/project/form/index"
          });
          return;
        }
        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack({
            delta: 1
          });
          return;
        }
        wx.switchTab({
          url: "/pages/profile/index"
        });
      }, 600);
    } finally {
      this.setData({
        isSaving: false
      });
    }
  }
});
