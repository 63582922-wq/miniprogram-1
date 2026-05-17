const { listReports, deleteReport } = require("../../../services/report");
const { formatDateTime } = require("../../../utils/format");

Page({
  data: {
    projectId: "",
    projectName: "",
    reports: []
  },
  onLoad(query) {
    this.setData({
      projectId: query.projectId || "",
      projectName: query.projectName ? decodeURIComponent(query.projectName) : ""
    });
  },
  onShow() {
    this.loadReports();
  },
  handleBackTap() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack({
        delta: 1
      });
      return;
    }
    wx.redirectTo({
      url: `/pages/project/detail/index?projectId=${this.data.projectId}`
    });
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
  openReport(event) {
    const reportId = event.currentTarget.dataset.reportId;
    wx.navigateTo({
      url: `/pages/report/detail/index?reportId=${reportId}`
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
