const { saveMemo, getMemoDetail } = require("../../../services/memo");
const { saveSubscription } = require("../../../services/subscribe");

Page({
  data: {
    projectId: "",
    memoId: "",
    pageTitle: "新增待办",
    remindAt: "",
    remindAtDisplay: "请选择提醒日期",
    subscribeStatus: "pending",
    voice: {
      voiceText: "",
      voiceFilePath: ""
    }
  },
  onLoad(query) {
    this.setData({
      projectId: query.projectId || "",
      memoId: query.memoId || "",
      pageTitle: query.memoId ? "编辑待办" : "新增待办"
    });
    if (query.memoId) {
      this.loadDetail(query.memoId);
    }
  },
  async loadDetail(memoId) {
    const result = await getMemoDetail(memoId);
    if (!result) {
      return;
    }
    this.setData({
      projectId: result.projectId || this.data.projectId,
      remindAt: result.remindAt || "",
      remindAtDisplay: result.remindAt || "请选择提醒日期",
      subscribeStatus: result.subscribeStatus || "pending",
      voice: {
        voiceText: result.voiceText || result.content || "",
        voiceFilePath: result.voiceFilePath || result.voiceFileId || ""
      }
    });
  },
  handleVoiceChange(event) {
    this.setData({
      voice: event.detail
    });
  },
  handleDateChange(event) {
    this.setData({
      remindAt: event.detail.value,
      remindAtDisplay: event.detail.value || "请选择提醒日期"
    });
  },
  async handleSubscribe() {
    try {
      const [settingResult] = await wx.requestSubscribeMessage({
        tmplIds: ["worksite-inspection-reminder"]
      });

      await saveSubscription({
        scene: "memo_remind",
        templateId: "worksite-inspection-reminder",
        accepted: Object.values(settingResult || {})[0] === "accept"
      });

      this.setData({
        subscribeStatus: Object.values(settingResult || {})[0] === "accept" ? "accepted" : "rejected"
      });

      wx.showToast({
        title: "提醒授权已记录",
        icon: "success"
      });
    } catch (error) {
      wx.showToast({
        title: "提醒授权未完成",
        icon: "none"
      });
    }
  },
  async handleSubmit() {
    if (!this.data.voice.voiceText && !this.data.voice.voiceFilePath) {
      wx.showToast({
        title: "请先录音或填写内容",
        icon: "none"
      });
      return;
    }

    await saveMemo({
      memoId: this.data.memoId,
      projectId: this.data.projectId,
      content: this.data.voice.voiceText || "语音备忘",
      voiceText: this.data.voice.voiceText,
      voiceFilePath: this.data.voice.voiceFilePath,
      remindAt: this.data.remindAt,
      subscribeStatus: this.data.subscribeStatus
    });

    wx.showToast({
      title: "保存成功",
      icon: "success"
    });

    setTimeout(() => {
      wx.navigateBack();
    }, 300);
  }
});
