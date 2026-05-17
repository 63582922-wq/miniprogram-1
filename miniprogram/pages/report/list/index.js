const { listReports, deleteReport } = require("../../../services/report");
const { listProjects } = require("../../../services/project");
const { formatDateTime } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");

const PENDING_REPORT_CONTEXT_KEY = "pendingReportContext";
const LAST_REPORT_CONTEXT_KEY = "lastReportContext";

Page({
  data: {
    projectId: "",
    projectName: "",
    pageTitle: "全部报告",
    isProjectMode: true,
    entrySource: "",
    reports: [],
    projects: []
  },
  onLoad(query) {
    const projectName = query.projectName ? decodeURIComponent(query.projectName) : "";
    this.setData({
      projectId: query.projectId || "",
      projectName,
      isProjectMode: !query.projectId,
      pageTitle: query.projectId ? "项目报告" : "全部报告"
    });
  },
  onShow() {
    if (this.applyStoredContext()) {
      this.loadReports();
      return;
    }

    if (this.data.isProjectMode) {
      this.loadProjects();
      return;
    }
    this.loadReports();
  },
  applyStoredContext() {
    const pending = wx.getStorageSync(PENDING_REPORT_CONTEXT_KEY);
    if (pending && pending.projectId) {
      wx.removeStorageSync(PENDING_REPORT_CONTEXT_KEY);
      this.applyProjectContext(pending.projectId, pending.projectName || "", pending.source || "");
      this.persistProjectContext(pending.projectId, pending.projectName || "");
      return true;
    }

    const remembered = wx.getStorageSync(LAST_REPORT_CONTEXT_KEY);
    if (remembered && remembered.projectId) {
      this.applyProjectContext(remembered.projectId, remembered.projectName || "", "");
      return true;
    }

    return false;
  },
  applyProjectContext(projectId, projectName, entrySource = "") {
    this.setData({
      projectId,
      projectName,
      isProjectMode: !projectId,
      entrySource,
      pageTitle: projectId ? "项目报告" : "全部报告"
    });
  },
  persistProjectContext(projectId, projectName) {
    if (!projectId) {
      wx.removeStorageSync(LAST_REPORT_CONTEXT_KEY);
      return;
    }
    wx.setStorageSync(LAST_REPORT_CONTEXT_KEY, {
      projectId,
      projectName
    });
  },
  async loadProjects() {
    try {
      const result = await listProjects();
      this.setData({
        projects: (result.list || []).map((item) => ({
          ...item,
          reportsCount: item.reportsCount || 0,
          lastInspectionAtDisplay: item.lastInspectionAt ? formatDateTime(item.lastInspectionAt) : "暂无报告"
        }))
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    }
  },
  async loadReports() {
    try {
      const result = await listReports({
        projectId: this.data.projectId
      });
      this.setData({
        reports: (result.list || []).map((item) => ({
          ...item,
          generatedAtDisplay: formatDateTime(item.generatedAt || item.createdAt) || "待生成"
        }))
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    }
  },
  openProjectReports(event) {
    const { projectId, projectName } = event.currentTarget.dataset;
    this.applyProjectContext(projectId, projectName || "", "");
    this.persistProjectContext(projectId, projectName || "");
    this.loadReports();
  },
  switchProjectMode() {
    this.applyProjectContext("", "", "");
    this.persistProjectContext("", "");
    this.setData({
      reports: []
    });
    this.loadProjects();
  },
  handleBackTap() {
    if (this.data.entrySource === "projectDetail" && this.data.projectId) {
      wx.navigateTo({
        url: `/pages/project/detail/index?projectId=${this.data.projectId}`
      });
      return;
    }

    if (!this.data.isProjectMode) {
      this.switchProjectMode();
      return;
    }

    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  openReport(event) {
    const reportId = event.currentTarget.dataset.reportId;
    const returnContext = this.data.projectId
      ? encodeReturnContext({
        projectId: this.data.projectId,
        projectName: this.data.projectName || "",
        returnTarget: this.data.entrySource === "projectDetail" ? "projectDetail" : "reportList",
        source: this.data.entrySource || ""
      })
      : "";
    wx.navigateTo({
      url: `/pages/report/detail/index?reportId=${reportId}${returnContext ? `&returnContext=${returnContext}` : ""}`
    });
  },
  async handleReportLongPress(event) {
    const reportId = event.currentTarget.dataset.reportId;
    const reportTitle = event.currentTarget.dataset.reportTitle || "该报告";
    if (!reportId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除报告"],
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
          title: "删除报告",
          content: `确定删除“${reportTitle}”吗？删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteReport(reportId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadReports();
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
