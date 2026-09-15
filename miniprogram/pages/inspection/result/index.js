const { confirmInspection } = require("../../../services/inspection");
const { uploadUserFile } = require("../../../services/cloud");
const { encodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");

function toChineseSectionNumber(value) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (value <= 10) {
    if (value === 10) {
      return "十";
    }
    return digits[value] || `${value}`;
  }
  if (value < 20) {
    return `十${digits[value - 10]}`;
  }
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${digits[tens]}十${ones ? digits[ones] : ""}`;
}

function getPrimaryIssueImage(item = {}) {
  return (item.annotatedImages && item.annotatedImages[0]) || (item.images && item.images[0]) || "";
}

function buildIssueGroups(issues = []) {
  const groups = [];
  const map = new Map();

  issues.forEach((item, index) => {
    const primaryImage = getPrimaryIssueImage(item);
    const key = primaryImage || `source-${item.sourceIndex ?? index}`;
    if (!map.has(key)) {
      const group = {
        key,
        sourceIndex: item.sourceIndex ?? index,
        image: primaryImage,
        issues: []
      };
      map.set(key, group);
      groups.push(group);
    }
    map.get(key).issues.push(Object.assign({}, item, {
      originalIndex: index
    }));
  });

  groups.sort((left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0));
  groups.forEach((group, index) => {
    group.issues.sort((left, right) => (left.subIssueIndex || 1) - (right.subIssueIndex || 1));
    group.displayTitle = `问题 ${toChineseSectionNumber(index + 1)}`;
  });
  return groups;
}

function cloneIssues(issues = []) {
  return JSON.parse(JSON.stringify(issues || []));
}

async function uploadPendingIssueAssets(form = {}) {
  const issueDrafts = await Promise.all(((form.issueDrafts) || []).map(async (item, index) => {
    const imagePath = item.imagePath && !item.imagePath.startsWith("cloud://")
      ? await uploadUserFile(item.imagePath, "inspection-images", `${index}.png`)
      : (item.imagePath || "");
    const annotatedImagePath = item.annotatedImagePath && !item.annotatedImagePath.startsWith("cloud://")
      ? await uploadUserFile(item.annotatedImagePath, "inspection-annotated-images", `${index}.png`)
      : (item.annotatedImagePath || "");
    let voiceStorageFileId = item.voiceStorageFileId || item.voiceFileId || "";
    if (item.voiceFilePath && !item.voiceFilePath.startsWith("cloud://") && !voiceStorageFileId) {
      voiceStorageFileId = await uploadUserFile(item.voiceFilePath, "inspection-audio", `${index}.mp3`);
    }
    return {
      ...item,
      imagePath,
      annotatedImagePath,
      voiceStorageFileId,
      voiceFileId: voiceStorageFileId
    };
  }));

  return {
    ...form,
    issueDrafts,
    images: issueDrafts.map((item) => item.imagePath).filter(Boolean)
  };
}

Page({
  data: {
    draftKey: "",
    sessionKey: "",
    returnContext: null,
    form: null,
    originalIssues: [],
    issues: [],
    issueGroups: [],
    summary: {
      projectName: "",
      title: "",
      contextNote: "",
      aiSummary: "",
      issueCount: 0,
      aiMode: "",
      memoryHint: "",
      memoryAlerts: []
    },
    submitting: false
  },
  onLoad(query) {
    const draft = wx.getStorageSync(query.draftKey) || {};
    const form = draft.form || {};
    const issues = cloneIssues(draft.analysis.items || []);
    const aiSummary = draft.analysis.summary || "";
    this.setData({
      draftKey: query.draftKey,
      sessionKey: draft.sessionKey || "",
      returnContext: draft.returnContext || null,
      form,
      originalIssues: cloneIssues(issues),
      issues,
      issueGroups: buildIssueGroups(issues),
      summary: {
        projectName: form.projectName || "未命名项目",
        title: form.title || "本次巡查",
        contextNote: form.note || "",
        aiSummary,
        issueCount: issues.length,
        aiMode: draft.analysis.aiMode || "",
        memoryHint: draft.analysis.memoryHint || "",
        memoryAlerts: draft.analysis.memoryAlerts || []
      }
    });
  },
  handleBackTap() {
    if (this.data.sessionKey) {
      wx.navigateBack({
        delta: 1
      });
      return;
    }
    returnToContext(this.data.returnContext);
  },
  handleHomeTap() {
    wx.showModal({
      title: "返回首页",
      content: "当前结果页的未提交修改不会保存，确认回首页吗？",
      success: (result) => {
        if (!result.confirm) {
          return;
        }
        wx.switchTab({
          url: "/pages/project/list/index"
        });
      }
    });
  },
  handleItemChange(event) {
    const { index, field, value } = event.detail;
    const issues = (this.data.issues || []).slice();
    issues[index][field] = value;
    this.setData({
      issues,
      issueGroups: buildIssueGroups(issues)
    });
  },

  /**
   * 删除误报。
   *
   * AI 难免有识别不准的条目（比如把反光当裂缝），必须有办法去掉，
   * 否则用户只能带着错的问题去提交巡查。
   *
   * 注意 issues 与 originalIssues 是平行数组（后者是 AI 原始输出，
   * 提交时按索引回填 aiRawResult 供后续学习修正习惯）。只删前者会让
   * 两者错位、把别人的 AI 结果挂到这条问题上，所以必须同步删。
   */
  handleDeleteIssue(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issues = (this.data.issues || []).slice();

    if (!Number.isInteger(index) || index < 0 || index >= issues.length) {
      return;
    }

    const target = issues[index] || {};
    const preview = `${target.description || ""}`.trim().slice(0, 30);

    wx.showModal({
      title: "删除这条问题？",
      content: preview || "该问题将从本次巡查中移除。",
      confirmText: "删除",
      confirmColor: "#B3402E",
      cancelText: "取消",
      success: (res) => {
        if (!res.confirm) {
          return;
        }

        const nextIssues = issues.filter((_, i) => i !== index);
        const nextOriginals = (this.data.originalIssues || []).filter((_, i) => i !== index);

        this.setData({
          issues: nextIssues,
          originalIssues: nextOriginals,
          issueGroups: buildIssueGroups(nextIssues),
          "summary.issueCount": nextIssues.length
        });

        wx.showToast({
          title: "已删除",
          icon: "none"
        });
      }
    });
  },

  /**
   * 一键全部通过并提交。
   *
   * AI 整理出的问题多数是准确的，逐条确认要点几十次；而现场是单手操作、
   * 人还在走动。这里给一条快速路径 —— 只有发现误报时才需要动手
   * （上方清单可以删除或直接修改）。
   */
  handleAcceptAllAndSubmit() {
    if (!(this.data.issues || []).length) {
      wx.showModal({
        title: "没有可提交的问题",
        content: "本次没有识别出问题项。可以返回上一步补充照片或语音说明。",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }
    this.handleSubmit();
  },

  async handleSubmit() {
    // 防重复提交：连点两次会创建两条巡查
    if (this.data.submitting) {
      return;
    }
    this.setData({ submitting: true });

    wx.showLoading({
      title: "提交中",
      mask: true
    });

    try {
      const uploadedForm = await uploadPendingIssueAssets(this.data.form || {});
      const result = await confirmInspection({
        form: Object.assign({}, uploadedForm, {
          aiSummary: this.data.summary.aiSummary
        }),
        items: this.data.issues,
        originalItems: this.data.originalIssues
      });
      markGuideStep("inspectionSubmitted", true);

      wx.removeStorageSync(this.data.draftKey);
      const returnContextQuery = encodeReturnContext(this.data.returnContext);
      wx.redirectTo({
        url: `/pages/inspection/detail/index?inspectionId=${result.inspectionId}${returnContextQuery ? `&returnContext=${returnContextQuery}` : ""}`
      });
    } catch (error) {
      wx.hideLoading();
      console.error("[inspection-result] submit failed", error);
      wx.showModal({
        title: "提交失败",
        content: (error && error.message) || "请检查网络后重试，草稿已保留。",
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
      wx.hideLoading();
      this.setData({ submitting: false });
    }
  }
});
