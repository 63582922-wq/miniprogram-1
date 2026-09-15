const { confirmInspection } = require("../../../services/inspection");
const { uploadUserFile } = require("../../../services/cloud");
const { encodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");
const { isCoachStep, moveCoach, stopCoach, getNextCoachStep, getPrevCoachStep, buildCoachTip } = require("../../../utils/coach");

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
    coachTipVisible: false,
    coachTipTitle: "",
    coachTipArrow: "",
    coachTipDesc: "",
    coachHighlightSubmit: false
  },
  onLoad(query) {
    const draft = wx.getStorageSync(query.draftKey) || {};
    const form = draft.form || {};
    const issues = cloneIssues(draft.analysis.items || []);
    const aiSummary = draft.analysis.summary || "";
    const active = isCoachStep("inspectionSubmit");
    const tip = buildCoachTip("inspectionSubmit");
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
      },
      coachTipVisible: active,
      coachTipTitle: tip.title,
      coachTipArrow: tip.arrow,
      coachTipDesc: tip.desc,
      coachHighlightSubmit: active
    });
  },
  handleCoachSkip() {
    stopCoach();
    this.setData({
      coachTipVisible: false,
      coachHighlightSubmit: false
    });
  },
  handleCoachPrev() {
    const prev = getPrevCoachStep("inspectionSubmit");
    if (!prev) {
      return;
    }
    moveCoach(prev);
    wx.navigateBack({
      delta: 1
    });
  },
  handleCoachNext() {
    const next = getNextCoachStep("inspectionSubmit");
    if (next) {
      moveCoach(next);
    }
    this.handleSubmit();
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
  async handleSubmit() {
    wx.showLoading({
      title: "提交中"
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
      if (isCoachStep("inspectionSubmit")) {
        moveCoach("reportGenerate");
      }

      wx.removeStorageSync(this.data.draftKey);
      const returnContextQuery = encodeReturnContext(this.data.returnContext);
      if (isCoachStep("reportGenerate")) {
        wx.redirectTo({
          url: `/pages/report/detail/index?inspectionId=${result.inspectionId}`
        });
        return;
      }
      wx.redirectTo({
        url: `/pages/inspection/detail/index?inspectionId=${result.inspectionId}${returnContextQuery ? `&returnContext=${returnContextQuery}` : ""}`
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "提交失败",
        icon: "none"
      });
    } finally {
      wx.hideLoading();
    }
  }
});
