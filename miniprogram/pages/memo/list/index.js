const { listMemos, saveMemo, deleteMemo } = require("../../../services/memo");
const PENDING_MEMO_CONTEXT_KEY = "pendingMemoContext";

Page({
  data: {
    memoList: [],
    projectId: "",
    projectName: ""
  },
  onLoad(query) {
    const projectId = query.projectId || "";
    const projectName = query.projectName ? decodeURIComponent(query.projectName) : "";
    this.applyMemoContext({
      projectId,
      projectName
    });
  },
  onShow() {
    const pendingContext = wx.getStorageSync(PENDING_MEMO_CONTEXT_KEY);
    if (pendingContext) {
      this.applyMemoContext(pendingContext);
      wx.removeStorageSync(PENDING_MEMO_CONTEXT_KEY);
    }
    this.loadMemos();
  },
  applyMemoContext(context = {}) {
    const projectId = context.projectId || "";
    const projectName = context.projectName || "";
    this.setData({
      projectId,
      projectName
    });

    wx.setNavigationBarTitle({
      title: projectName ? `${projectName}待办` : "待办"
    });
  },
  handleBackTap() {
    if (this.data.projectId) {
      wx.navigateTo({
        url: `/pages/project/detail/index?projectId=${this.data.projectId}`
      });
      return;
    }
    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  async loadMemos() {
    const result = await listMemos({
      projectId: this.data.projectId
    });
    this.setData({
      memoList: (result.list || []).map((item) => ({
        ...item,
        remindAtDisplay: item.remindAtText || item.remindAt || "未设置提醒",
        subscribeStatusDisplay: item.subscribeStatusText || "待订阅提醒"
      }))
    });
  },
  goCreate() {
    wx.navigateTo({
      url: this.data.projectId
        ? `/pages/memo/form/index?projectId=${this.data.projectId}`
        : "/pages/memo/form/index"
    });
  },
  goEdit(event) {
    const memoId = event.currentTarget.dataset.memoId;
    wx.navigateTo({
      url: `/pages/memo/form/index?memoId=${memoId}`
    });
  },
  async handleMemoLongPress(event) {
    const memoId = event.currentTarget.dataset.memoId;
    const memoContent = event.currentTarget.dataset.memoContent || "该待办";
    if (!memoId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除待办"],
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
          title: "删除待办",
          content: `确定删除“${memoContent}”吗？删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteMemo(memoId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadMemos();
    } catch (error) {
      if (error && /cancel/i.test(error.errMsg || "")) {
        return;
      }
      wx.showToast({
        title: error.message || "删除失败",
        icon: "none"
      });
    }
  },
  async updateMemoStatus(event) {
    const { memoId, status } = event.currentTarget.dataset;
    const current = (this.data.memoList || []).find((item) => item._id === memoId);
    if (!current) {
      return;
    }

    await saveMemo({
      memoId,
      projectId: current.projectId,
      content: current.content,
      voiceText: current.voiceText,
      voiceFilePath: current.voiceFilePath || current.voiceFileId || "",
      remindAt: current.remindAt || "",
      subscribeStatus: current.subscribeStatus || "pending",
      status
    });

    wx.showToast({
      title: "已更新",
      icon: "success"
    });
    this.loadMemos();
  }
});
