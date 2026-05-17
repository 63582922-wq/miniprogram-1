const { analyzeChat, getChatAnalysisDetail } = require("../../services/chat");

Page({
  data: {
    projectId: "",
    analysisId: "",
    sourceText: "",
    result: null
  },
  onLoad(query) {
    this.setData({
      projectId: query.projectId || "",
      analysisId: query.analysisId || ""
    });
  },
  async onShow() {
    if (this.data.analysisId) {
      await this.loadHistoryResult();
    }
  },
  async loadHistoryResult() {
    try {
      const result = await getChatAnalysisDetail({
        analysisId: this.data.analysisId
      });
      if (!result) {
        return;
      }
      this.setData({
        sourceText: result.sourceText || "",
        result
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    }
  },
  handleInput(event) {
    this.setData({
      sourceText: event.detail.value
    });
  },
  async handleAnalyze() {
    if (!this.data.sourceText) {
      wx.showToast({
        title: "请先粘贴聊天内容",
        icon: "none"
      });
      return;
    }

    wx.showLoading({
      title: "分析中"
    });

    try {
      const result = await analyzeChat({
        projectId: this.data.projectId,
        sourceText: this.data.sourceText
      });
      this.setData({
        analysisId: result._id || "",
        result
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "分析失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
    }
  }
});
