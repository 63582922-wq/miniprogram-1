const { listInspections, deleteInspection } = require("../../../services/inspection");
const { formatDateTime } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");

Page({
  data: {
    inspectionList: [],
    projectId: "",
    projectName: "",
    pageTitle: "巡查"
  },
  onLoad(query) {
    const projectId = query.projectId || "";
    const projectName = query.projectName ? decodeURIComponent(query.projectName) : "";
    this.setData({
      projectId,
      projectName,
      pageTitle: projectName ? `${projectName}巡查` : "巡查"
    });
  },
  onShow() {
    this.loadInspections();
  },
  async loadInspections() {
    try {
      const result = await listInspections({
        projectId: this.data.projectId
      });
      this.setData({
        inspectionList: (result.list || []).map((item) => ({
          ...item,
          createdAtText: formatDateTime(item.createdAt),
          projectNameText: item.projectName || "未关联项目"
        }))
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    }
  },
  goCreate() {
    let returnContext = "";
    if (this.data.projectId) {
      const context = {
        projectId: this.data.projectId,
        projectName: this.data.projectName || "",
        returnTarget: "inspectionList"
      };
      wx.setStorageSync("pendingInspectionProject", context);
      returnContext = encodeReturnContext(context);
    }

    wx.navigateTo({
      url: `/pages/inspection/create/index${returnContext ? `?returnContext=${returnContext}` : ""}`
    });
  },
  openDetail(event) {
    const inspectionId = event.currentTarget.dataset.inspectionId;
    const returnContext = this.data.projectId
      ? encodeReturnContext({
        projectId: this.data.projectId,
        projectName: this.data.projectName || "",
        returnTarget: "inspectionList"
      })
      : "";
    wx.navigateTo({
      url: `/pages/inspection/detail/index?inspectionId=${inspectionId}${returnContext ? `&returnContext=${returnContext}` : ""}`
    });
  },
  async handleInspectionLongPress(event) {
    const inspectionId = event.currentTarget.dataset.inspectionId;
    const inspectionTitle = event.currentTarget.dataset.inspectionTitle || "该巡查";
    if (!inspectionId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除巡查"],
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
          title: "删除巡查",
          content: `确定删除“${inspectionTitle}”吗？关联问题项和报告也会一起移除，删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteInspection(inspectionId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadInspections();
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
