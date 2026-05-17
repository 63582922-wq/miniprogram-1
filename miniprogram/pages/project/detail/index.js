const { getProjectDetail } = require("../../../services/project");
const { formatDateTime, mapProjectStatusText } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");
const { isCoachStep, moveCoach, stopCoach, getNextCoachStep, getPrevCoachStep, buildCoachTip } = require("../../../utils/coach");

Page({
  data: {
    projectId: "",
    project: {},
    recentInspectionExpanded: false,
    recentReportExpanded: false,
    recentChatExpanded: false,
    workspaceStats: {
      inspections: 0,
      reports: 0,
      pendingMemos: 0,
      chats: 0
    },
    inspections: [],
    reports: [],
    latestInspection: null,
    latestReport: null,
    latestChat: null,
    memos: [],
    chatAnalysis: [],
    coachTipVisible: false,
    coachTipTitle: "",
    coachTipArrow: "",
    coachTipDesc: "",
    coachHighlightInspection: false
  },
  async onLoad(query) {
    this.setData({
      projectId: query.projectId || ""
    });
  },
  onShow() {
    const active = isCoachStep("projectDetailInspection");
    const tip = buildCoachTip("projectDetailInspection");
    this.setData({
      coachTipVisible: active,
      coachTipTitle: tip.title,
      coachTipArrow: tip.arrow,
      coachTipDesc: tip.desc,
      coachHighlightInspection: active
    });
    if (this.data.projectId) {
      this.loadDetail();
    }
  },
  handleCoachSkip() {
    stopCoach();
    this.setData({
      coachTipVisible: false,
      coachHighlightInspection: false
    });
  },
  handleCoachPrev() {
    const prev = getPrevCoachStep("projectDetailInspection");
    if (!prev) {
      return;
    }
    moveCoach(prev);
    wx.navigateTo({
      url: "/pages/project/form/index"
    });
  },
  handleCoachNext() {
    const next = getNextCoachStep("projectDetailInspection");
    if (!next) {
      return;
    }
    moveCoach(next);
    this.goInspectionCreate();
  },
  async loadDetail() {
    try {
      const result = await getProjectDetail(this.data.projectId);
      this.setData({
        project: {
          ...(result.project || {}),
          clientNameText: (result.project && result.project.clientName) || "未填写",
          clientPhoneText: (result.project && result.project.clientPhone) || "",
          descriptionText: (result.project && result.project.description) || "暂无项目说明",
          statusText: mapProjectStatusText(result.project && result.project.status)
        },
        inspections: (result.inspections || []).map((item) => ({
          ...item,
          createdAtText: formatDateTime(item.createdAt)
        })),
        reports: (result.reports || []).map((item) => ({
          ...item,
          generatedAtDisplay: formatDateTime(item.generatedAt || item.createdAt) || "待生成"
        })),
        latestInspection: (result.inspections || []).length ? {
          ...(result.inspections || [])[0],
          createdAtText: formatDateTime((result.inspections || [])[0].createdAt)
        } : null,
        latestReport: (result.reports || []).length ? {
          ...(result.reports || [])[0],
          generatedAtDisplay: formatDateTime((result.reports || [])[0].generatedAt || (result.reports || [])[0].createdAt) || "待生成"
        } : null,
        latestChat: (result.chatAnalysis || []).length ? (result.chatAnalysis || [])[0] : null,
        memos: result.memos || [],
        chatAnalysis: result.chatAnalysis || [],
        workspaceStats: {
          inspections: (result.inspections || []).length,
          reports: (result.reports || []).length,
          pendingMemos: (result.memos || []).filter((item) => !["completed", "closed"].includes(item.status || "pending")).length,
          chats: (result.chatAnalysis || []).length
        }
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    }
  },
  goEdit() {
    wx.navigateTo({
      url: `/pages/project/form/index?projectId=${this.data.projectId}`
    });
  },
  goInspectionCreate() {
    if (isCoachStep("projectDetailInspection")) {
      moveCoach("inspectionAddPhoto");
    }
    const context = {
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      returnTarget: "projectDetail"
    };
    wx.setStorageSync("pendingInspectionProject", context);
    const returnContext = encodeReturnContext(context);
    wx.navigateTo({
      url: `/pages/inspection/create/index?returnContext=${returnContext}`
    });
  },
  goChatAnalysis() {
    wx.navigateTo({
      url: `/pages/chat-analysis/index?projectId=${this.data.projectId}`
    });
  },
  goMemoForm() {
    wx.navigateTo({
      url: `/pages/memo/form/index?projectId=${this.data.projectId}`
    });
  },
  goMemoList() {
    wx.navigateTo({
      url: `/pages/memo/project/index?projectId=${this.data.projectId}&projectName=${encodeURIComponent(this.data.project.name || "")}`
    });
  },
  goGallery() {
    wx.navigateTo({
      url: `/pages/project/gallery/index?projectId=${this.data.projectId}`
    });
  },
  goInspectionList() {
    wx.navigateTo({
      url: `/pages/inspection/list/index?projectId=${this.data.projectId}&projectName=${encodeURIComponent(this.data.project.name || "")}`
    });
  },
  goReportList() {
    wx.navigateTo({
      url: `/pages/report/project/index?projectId=${this.data.projectId}&projectName=${encodeURIComponent(this.data.project.name || "")}`
    });
  },
  toggleRecentInspection() {
    this.setData({
      recentInspectionExpanded: !this.data.recentInspectionExpanded
    });
  },
  toggleRecentReport() {
    this.setData({
      recentReportExpanded: !this.data.recentReportExpanded
    });
  },
  toggleRecentChat() {
    this.setData({
      recentChatExpanded: !this.data.recentChatExpanded
    });
  },
  openInspection(event) {
    const inspectionId = event.currentTarget.dataset.inspectionId;
    const returnContext = encodeReturnContext({
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      returnTarget: "projectDetail"
    });
    wx.navigateTo({
      url: `/pages/inspection/detail/index?inspectionId=${inspectionId}&returnContext=${returnContext}`
    });
  },
  openReport(event) {
    const reportId = event.currentTarget.dataset.reportId;
    const returnContext = encodeReturnContext({
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      returnTarget: "projectDetail"
    });
    wx.navigateTo({
      url: `/pages/report/detail/index?reportId=${reportId}&returnContext=${returnContext}`
    });
  },
  openLatestChat() {
    const latest = (this.data.chatAnalysis || [])[0];
    wx.navigateTo({
      url: latest && latest._id
        ? `/pages/chat-analysis/index?projectId=${this.data.projectId}&analysisId=${latest._id}`
        : `/pages/chat-analysis/index?projectId=${this.data.projectId}`
    });
  }
});
