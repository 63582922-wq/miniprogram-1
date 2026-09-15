const { listProjects } = require("../../../services/project");
const { analyzeInspection, createInspectionTask, getInspectionTaskStatus } = require("../../../services/inspection");
const { uploadUserFile } = require("../../../services/cloud");
const { transcribeVoiceFile, mergeSpeechText, formatSpeechError } = require("../../../services/speech");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { isCoachStep, moveCoach, stopCoach, getNextCoachStep, getPrevCoachStep, buildCoachTip } = require("../../../utils/coach");
const { runWithConcurrency } = require("../../../utils/async");

const recorderManager = wx.getRecorderManager();
const MAX_ISSUE_DRAFTS = 20;
const SINGLE_PICK_LIMIT = 9;
/** 附件上传的并发上限：弱网下并发太高会让整批一起超时 */
const UPLOAD_CONCURRENCY = 3;
const PENDING_PROJECT_KEY = "pendingInspectionProject";
const LATEST_INSPECTION_DRAFT_META_KEY = "latestInspectionDraftMeta";
const ASYNC_ANALYZE_THRESHOLD = 3;
const ANALYZE_POLL_INTERVAL = 1500;
/** 轮询连续失败多少次后停止等待（每次失败会退避重试） */
const ANALYZE_POLL_MAX_FAILURES = 5;
const ISSUE_SECTION_TITLES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];

function createIssueDraft(filePath) {
  return {
    id: `${Date.now()}-${Math.random()}`,
    imagePath: filePath,
    annotations: [],
    voiceText: "",
    voiceFilePath: "",
    voiceFileId: ""
  };
}

function buildIssueExpandedStates(issueDrafts = [], previousStates = []) {
  return issueDrafts.map((_, index) => {
    if (typeof previousStates[index] === "boolean") {
      return previousStates[index];
    }
    return index === issueDrafts.length - 1;
  });
}

function buildExpandedStatesAfterAppend(previousCount, appendCount) {
  const total = previousCount + appendCount;
  if (total <= 0) {
    return [];
  }

  return Array.from({ length: total }, (_, index) => index === total - 1);
}

function createInitialForm() {
  return {
    projectId: "",
    projectName: "",
    title: "",
    note: "",
    issueDrafts: []
  };
}

function createDraftSnapshot(form = {}, returnContext = null) {
  return {
    form,
    returnContext: returnContext || null
  };
}

function extractDraftForm(snapshot) {
  if (snapshot && snapshot.form && snapshot.form.issueDrafts) {
    return snapshot.form;
  }
  return snapshot || null;
}

function extractDraftReturnContext(snapshot) {
  if (snapshot && snapshot.form && snapshot.returnContext) {
    return snapshot.returnContext;
  }
  return null;
}

function buildLatestDraftMeta(sessionKey, form = {}) {
  return {
    sessionKey,
    projectId: form.projectId || "",
    projectName: form.projectName || "",
    title: form.title || "",
    issueCount: (form.issueDrafts || []).length,
    updatedAt: Date.now()
  };
}

function hasMeaningfulDraftContent(form = {}) {
  return Boolean(
    (form.title || "").trim() ||
    (form.note || "").trim() ||
    ((form.issueDrafts || []).length)
  );
}

function hasMeaningfulVoiceText(text = "") {
  return `${text || ""}`.trim().length > 0;
}

function countImageRecognitionDrafts(issueDrafts = []) {
  return (issueDrafts || []).filter((item) => !hasMeaningfulVoiceText(item.voiceText)).length;
}

function isPrivacyScopeUndeclared(error) {
  const text = `${(error && error.errMsg) || (error && error.message) || ""}`;
  return /api scope is not declared in the privacy agreement/i.test(text) || `${error && error.errno}` === "112";
}

function isUserCancelledPrivacyOrPicker(error) {
  const text = `${(error && error.errMsg) || (error && error.message) || ""}`.toLowerCase();
  return text.includes("cancel") || text.includes("denied") || text.includes("reject");
}

Page({
  data: {
    projects: [],
    projectIndex: 0,
    currentProjectNameText: "请选择项目",
    projectLoadError: "",
    loadingProjects: false,
    sessionKey: "",
    recordingIssueId: "",
    transcribingIssueId: "",
    transcribeStartedAt: 0,
    issueExpandedStates: [],
    showSupplementFields: false,
    analyzing: false,
    analyzeStageText: "",
    analyzeStageIndex: 0,
    analyzeTaskId: "",
    returnContext: null,
    issueSectionTitles: ISSUE_SECTION_TITLES,
    form: createInitialForm(),
    coachTipVisible: false,
    coachTipTitle: "",
    coachTipArrow: "",
    coachTipText: "",
    coachHighlightAddPhoto: false,
    coachHighlightAnalyze: false
  },
  onLoad(query) {
    recorderManager.onStop((result) => {
      const transcribingIssueId = this.data.transcribingIssueId;

      if (transcribingIssueId) {
        const duration = Math.max(0, Date.now() - (this.data.transcribeStartedAt || 0));
        
        const issueDrafts = this.data.form.issueDrafts.map(item => {
          if (item.id === transcribingIssueId) {
            return { ...item, isTranscribing: true, voiceFilePath: result.tempFilePath };
          }
          return item;
        });
        
        this.setData({
          transcribingIssueId: "",
          "form.issueDrafts": issueDrafts
        });

        this.triggerRecordVibration();
        this.handleIssueTranscription(transcribingIssueId, result.tempFilePath, duration);
      }
    });
    const initialReturnContext = decodeReturnContext(query.returnContext) || null;
    if (query.sessionKey) {
      this.setData({
        sessionKey: query.sessionKey,
        returnContext: initialReturnContext
      });
      this.restoreDraft();
      setTimeout(() => {
        this.loadProjects(query.projectId);
      }, 0);
      return;
    }

    const latestDraftMeta = this.getLatestDraftMeta();
    if (latestDraftMeta && latestDraftMeta.sessionKey && (latestDraftMeta.issueCount || 0) > 0) {
      this.setData({
        sessionKey: latestDraftMeta.sessionKey,
        returnContext: initialReturnContext
      });
      this.restoreDraft();
      wx.showModal({
        title: "继续上次编辑",
        content: `发现一份未完成的快速巡查草稿${latestDraftMeta.projectName ? `（${latestDraftMeta.projectName}）` : ""}，已添加 ${latestDraftMeta.issueCount || 0} 个问题，是否继续编辑？`,
        confirmText: "继续上次",
        cancelText: "新建本次",
        success: (result) => {
          if (!result.confirm) {
            this.clearDraft();
            this.setData({
              sessionKey: this.createSessionKey(),
              returnContext: initialReturnContext,
              issueExpandedStates: [],
              showSupplementFields: false,
              recordingIssueId: "",
              transcribingIssueId: "",
              transcribeStartedAt: 0,
              analyzing: false,
              analyzeStageText: "",
              analyzeStageIndex: 0,
              analyzeTaskId: "",
              form: createInitialForm()
            });
          }
          this.loadProjects(result.confirm ? (this.data.form.projectId || query.projectId) : query.projectId);
        },
        fail: () => {
          this.loadProjects(this.data.form.projectId || query.projectId);
        }
      });
      return;
    }

    this.setData({
      sessionKey: this.createSessionKey(),
      returnContext: initialReturnContext
    });
    setTimeout(() => {
      this.loadProjects(query.projectId);
    }, 0);
  },
  onShow() {
    const restored = this.restoreDraft();
    this.applyPendingProjectSelection();
    
    const pendingPhotos = wx.getStorageSync("pendingPhotos");
    const pendingProject = wx.getStorageSync(PENDING_PROJECT_KEY);

    if (!restored && !pendingPhotos && !pendingProject && this.hasUnsavedDraft()) {
      this.resetForNewInspection();
    }

    if (pendingPhotos && pendingPhotos.length > 0) {
      wx.removeStorageSync("pendingPhotos");
      const currentCount = (this.data.form.issueDrafts || []).length;
      const remaining = MAX_ISSUE_DRAFTS - currentCount;
      if (remaining > 0) {
        const toAdd = pendingPhotos.slice(0, remaining);
        const issueDrafts = (this.data.form.issueDrafts || []).concat(
          toAdd.map((item) => createIssueDraft(item))
        );
        const issueExpandedStates = buildExpandedStatesAfterAppend(
          this.data.form.issueDrafts.length,
          toAdd.length
        );
        this.setData({
          "form.issueDrafts": issueDrafts,
          issueExpandedStates
        });
        this.persistDraft();
        if (pendingPhotos.length > remaining) {
          wx.showToast({
            title: "最多添加20张照片",
            icon: "none"
          });
        }
      } else {
        wx.showToast({
          title: "已达到20张上限",
          icon: "none"
        });
      }
    }
    this.updateUnloadAlert();
    if (this.data.analyzing && this.data.analyzeTaskId) {
      this.scheduleAnalyzeTaskPolling();
    }
    this.syncCoachTip();
  },
  syncCoachTip() {
    if (isCoachStep("inspectionAddPhoto")) {
      const tip = buildCoachTip("inspectionAddPhoto");
      this.setData({
        coachTipVisible: true,
        coachTipTitle: tip.title,
        coachTipArrow: tip.arrow,
        coachTipText: tip.desc,
        coachHighlightAddPhoto: true,
        coachHighlightAnalyze: false
      });
      return;
    }
    if (isCoachStep("inspectionAnalyze")) {
      const tip = buildCoachTip("inspectionAnalyze");
      this.setData({
        coachTipVisible: true,
        coachTipTitle: tip.title,
        coachTipArrow: tip.arrow,
        coachTipText: tip.desc,
        coachHighlightAddPhoto: false,
        coachHighlightAnalyze: true
      });
      return;
    }
    this.setData({
      coachTipVisible: false,
      coachTipTitle: "",
      coachTipArrow: "",
      coachTipText: "",
      coachHighlightAddPhoto: false,
      coachHighlightAnalyze: false
    });
  },
  handleCoachSkip() {
    stopCoach();
    this.syncCoachTip();
  },
  handleCoachPrev() {
    if (isCoachStep("inspectionAnalyze")) {
      moveCoach("inspectionAddPhoto");
      this.syncCoachTip();
      return;
    }
    const prev = getPrevCoachStep("inspectionAddPhoto");
    if (!prev) {
      return;
    }
    moveCoach(prev);
    if (this.data.returnContext && this.data.returnContext.projectId) {
      wx.navigateTo({
        url: `/pages/project/detail/index?projectId=${this.data.returnContext.projectId}`
      });
      return;
    }
    wx.navigateBack({
      delta: 1
    });
  },
  handleCoachNext() {
    if (isCoachStep("inspectionAddPhoto")) {
      moveCoach("inspectionAnalyze");
      this.syncCoachTip();
      return;
    }
    const next = getNextCoachStep("inspectionAnalyze");
    if (next) {
      moveCoach(next);
    }
    this.handleAnalyze();
  },
  onHide() {
    this.clearAnalyzeTaskPolling();
  },
  onUnload() {
    this.clearAnalyzeTaskPolling();
  },
  persistDraft() {
    if (!this.data.sessionKey) {
      return;
    }

    wx.setStorageSync(this.data.sessionKey, createDraftSnapshot(this.data.form, this.data.returnContext));
    if (hasMeaningfulDraftContent(this.data.form)) {
      wx.setStorageSync(LATEST_INSPECTION_DRAFT_META_KEY, buildLatestDraftMeta(this.data.sessionKey, this.data.form));
    } else {
      const latestDraftMeta = this.getLatestDraftMeta();
      if (latestDraftMeta && latestDraftMeta.sessionKey === this.data.sessionKey) {
        wx.removeStorageSync(LATEST_INSPECTION_DRAFT_META_KEY);
      }
    }
    this.updateUnloadAlert();
  },
  clearDraft() {
    if (!this.data.sessionKey) {
      return;
    }
    wx.removeStorageSync(this.data.sessionKey);
    const latestDraftMeta = this.getLatestDraftMeta();
    if (latestDraftMeta && latestDraftMeta.sessionKey === this.data.sessionKey) {
      wx.removeStorageSync(LATEST_INSPECTION_DRAFT_META_KEY);
    }
    this.updateUnloadAlert();
  },
  createSessionKey() {
    return `inspection-create-${Date.now()}`;
  },
  getLatestDraftMeta() {
    return wx.getStorageSync(LATEST_INSPECTION_DRAFT_META_KEY) || null;
  },
  resetForNewInspection() {
    const preservedProjectId = this.data.form.projectId || "";
    const preservedProjectName = this.data.form.projectName || "";
    const nextSessionKey = this.createSessionKey();

    this.setData({
      sessionKey: nextSessionKey,
      issueExpandedStates: [],
      showSupplementFields: false,
      recordingIssueId: "",
      transcribingIssueId: "",
      transcribeStartedAt: 0,
      analyzing: false,
      analyzeStageText: "",
      analyzeStageIndex: 0,
      returnContext: null,
      form: {
        ...createInitialForm(),
        projectId: preservedProjectId,
        projectName: preservedProjectName
      }
    });
    this.updateUnloadAlert();
  },
  restoreDraft() {
    if (!this.data.sessionKey) {
      return false;
    }

    const cached = wx.getStorageSync(this.data.sessionKey);
    const cachedForm = extractDraftForm(cached);
    const cachedReturnContext = extractDraftReturnContext(cached);
    if (cachedForm && cachedForm.issueDrafts) {
      this.setData({
        form: {
          ...this.data.form,
          ...cachedForm
        },
        returnContext: cachedReturnContext || this.data.returnContext || null,
        issueExpandedStates: buildIssueExpandedStates(cachedForm.issueDrafts || [], this.data.issueExpandedStates),
        showSupplementFields: Boolean((cachedForm.title || "").trim() || (cachedForm.note || "").trim())
      });
      return true;
    }
    return false;
  },
  hasUnsavedDraft() {
    return hasMeaningfulDraftContent(this.data.form || {});
  },
  updateUnloadAlert() {
    if (!this.hasUnsavedDraft()) {
      if (typeof wx.disableAlertBeforeUnload === "function") {
        wx.disableAlertBeforeUnload();
      }
      return;
    }
    if (typeof wx.enableAlertBeforeUnload !== "function") {
      return;
    }
    wx.enableAlertBeforeUnload({
      message: "当前巡查有未保存内容，确定返回？返回后草稿仍保留，可在「快速巡查」继续编辑。"
    });
  },
  async loadProjects(defaultProjectId) {
    this.setData({
      loadingProjects: true,
      projectLoadError: ""
    });

    try {
      const result = await listProjects({ pageSize: 100 });
      const projects = result.list || [];
      let projectIndex = 0;
      let projectId = defaultProjectId || "";

      if (!projectId && projects[0]) {
        projectId = projects[0]._id;
      }

      if (projectId) {
        projectIndex = Math.max(projects.findIndex((item) => item._id === projectId), 0);
      }

      this.setData({
        projects,
        projectIndex,
        currentProjectNameText: (projects[projectIndex] && projects[projectIndex].name) || "请选择项目",
        "form.projectId": projectId,
        "form.projectName": (projects[projectIndex] && projects[projectIndex].name) || ""
      });
      this.applyPendingProjectSelection();
      this.persistDraft();
    } catch (error) {
      this.setData({
        projects: [],
        projectIndex: 0,
        currentProjectNameText: "项目加载失败",
        projectLoadError: error.message || "项目加载失败",
        "form.projectId": ""
      });
      wx.showToast({
        title: "项目加载超时，请重试",
        icon: "none"
      });
    } finally {
      this.setData({
        loadingProjects: false
      });
    }
  },
  retryLoadProjects() {
    this.loadProjects(this.data.form.projectId);
  },
  leaveCurrentPage(options = {}) {
    const { preserveDraft = false, goHome = false } = options;
    const context = this.data.returnContext;
    if (typeof wx.disableAlertBeforeUnload === "function") {
      wx.disableAlertBeforeUnload();
    }
    if (!preserveDraft) {
      this.clearDraft();
    }
    if (goHome) {
      wx.switchTab({
        url: "/pages/project/list/index"
      });
      return;
    }
    returnToContext(context);
  },
  applyPendingProjectSelection() {
    const pending = wx.getStorageSync(PENDING_PROJECT_KEY);
    if (!pending || !pending.projectId || !(this.data.projects || []).length) {
      return;
    }

    const projectIndex = this.data.projects.findIndex((item) => item._id === pending.projectId);
    if (projectIndex < 0) {
      wx.removeStorageSync(PENDING_PROJECT_KEY);
      return;
    }

    const project = this.data.projects[projectIndex];
    this.setData({
      projectIndex,
      currentProjectNameText: project.name || "请选择项目",
      "form.projectId": project._id || "",
      "form.projectName": project.name || "",
      returnContext: {
        projectId: project._id || "",
        projectName: project.name || "",
        returnTarget: pending.returnTarget || ""
      }
    });
    this.persistDraft();
    wx.removeStorageSync(PENDING_PROJECT_KEY);
  },
  handleReturn() {
    if (!this.hasUnsavedDraft()) {
      this.leaveCurrentPage();
      return;
    }

    wx.showActionSheet({
      itemList: ["保存草稿并离开", "直接离开"],
      success: (result) => {
        if (result.tapIndex === 0) {
          this.persistDraft();
          this.leaveCurrentPage({
            preserveDraft: true
          });
          return;
        }
        if (result.tapIndex === 1) {
          this.leaveCurrentPage();
        }
      }
    });
  },
  handleHomeTap() {
    if (!this.hasUnsavedDraft()) {
      this.leaveCurrentPage({
        goHome: true
      });
      return;
    }

    wx.showActionSheet({
      itemList: ["保存草稿并回首页", "直接回首页"],
      success: (result) => {
        if (result.tapIndex === 0) {
          this.persistDraft();
          this.leaveCurrentPage({
            preserveDraft: true,
            goHome: true
          });
          return;
        }
        if (result.tapIndex === 1) {
          this.leaveCurrentPage({
            goHome: true
          });
        }
      }
    });
  },
  handleProjectChange(event) {
    const projectIndex = Number(event.detail.value);
    const project = this.data.projects[projectIndex] || {};
    this.setData({
      projectIndex,
      currentProjectNameText: project.name || "请选择项目",
      "form.projectId": project._id || "",
      "form.projectName": project.name || ""
    });
    this.persistDraft();
  },
  handleInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({
      [`form.${field}`]: event.detail.value
    });
    this.persistDraft();
  },
  toggleSupplementFields() {
    this.setData({
      showSupplementFields: !this.data.showSupplementFields
    });
  },
  chooseImages() {
    const currentCount = (this.data.form.issueDrafts || []).length;
    const remaining = MAX_ISSUE_DRAFTS - currentCount;

    if (remaining <= 0) {
      wx.showToast({
        title: "最多添加20张照片",
        icon: "none"
      });
      return;
    }

    const page = this;
    const count = Math.min(remaining, SINGLE_PICK_LIMIT);

    const commitPickedPaths = (paths) => {
      const list = (paths || []).filter(Boolean);
      if (!list.length) {
        return;
      }
      const issueDrafts = (page.data.form.issueDrafts || []).concat(list.map((p) => createIssueDraft(p)));
      const issueExpandedStates = buildExpandedStatesAfterAppend(page.data.form.issueDrafts.length, list.length);

      page.setData({
        "form.issueDrafts": issueDrafts,
        issueExpandedStates
      });
      page.persistDraft();
      if (isCoachStep("inspectionAddPhoto") && issueDrafts.length > 0) {
        moveCoach("inspectionAnalyze");
        page.syncCoachTip();
      }

      if (issueDrafts.length >= MAX_ISSUE_DRAFTS) {
        wx.showToast({
          title: "已达到20张上限",
          icon: "none"
        });
      }
    };

    const handlePickerFail = (error) => {
      if (isPrivacyScopeUndeclared(error)) {
        wx.showModal({
          title: "需完善隐私声明",
          content: "当前小程序后台未声明「相机/相册」用途，请先在微信公众平台补充隐私指引后再试。",
          showCancel: false
        });
        return;
      }
      if (isUserCancelledPrivacyOrPicker(error)) {
        return;
      }
      wx.showToast({
        title: "无法打开相册或相机",
        icon: "none"
      });
    };

    const openIssueImagePicker = (sourceType) => {
      if (typeof wx.chooseMedia !== "function") {
        wx.showToast({
          title: "当前基础库不支持选图",
          icon: "none"
        });
        return;
      }
      wx.chooseMedia({
        count,
        mediaType: ["image"],
        sourceType: [sourceType],
        success(res) {
          const paths = (res.tempFiles || []).map((f) => f.tempFilePath);
          commitPickedPaths(paths);
        },
        fail(error) {
          handlePickerFail(error);
        }
      });
    };

    wx.showActionSheet({
      itemList: ["拍照", "从相册选择"],
      success: ({ tapIndex }) => {
        if (tapIndex === 0) {
          openIssueImagePicker("camera");
          return;
        }
        if (tapIndex === 1) {
          openIssueImagePicker("album");
        }
      }
    });
  },
  async replaceIssueImage(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issue = this.data.form.issueDrafts[index];
    if (!issue) {
      return;
    }

    const confirmResult = await new Promise((resolve) => {
      wx.showModal({
        title: "更换照片",
        content: "更换后会清空当前照片上的标注，语音和文字会保留，确定继续吗？",
        confirmText: "更换",
        success: resolve
      });
    });

    if (!confirmResult.confirm) {
      return;
    }

    let result;
    try {
      result = await wx.chooseMedia({
        count: 1,
        mediaType: ["image"],
        sourceType: ["album", "camera"]
      });
    } catch (error) {
      if (isPrivacyScopeUndeclared(error)) {
        wx.showModal({
          title: "需完善隐私声明",
          content: "当前小程序后台未声明「相机/相册」用途，请先在微信公众平台补充隐私指引后再试。",
          showCancel: false
        });
        return;
      }
      if (`${(error && error.errMsg) || ""}`.toLowerCase().includes("cancel")) {
        return;
      }
      return;
    }

    const tempFile = result.tempFiles && result.tempFiles[0];
    if (!tempFile) {
      return;
    }

    this.setData({
      [`form.issueDrafts[${index}].imagePath`]: tempFile.tempFilePath,
      [`form.issueDrafts[${index}].annotatedImagePath`]: "",
      [`form.issueDrafts[${index}].annotations`]: []
    });
    this.persistDraft();
    wx.showToast({
      title: "照片已更换",
      icon: "success"
    });
  },
  handleIssueVoiceTextInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    this.setData({
      [`form.issueDrafts[${index}].voiceText`]: event.detail.value
    });
    this.persistDraft();
  },
  toggleIssueExpanded(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issueExpandedStates = (this.data.issueExpandedStates || []).slice();
    issueExpandedStates[index] = !issueExpandedStates[index];
    this.setData({
      issueExpandedStates
    });
  },
  triggerRecordVibration() {
    if (typeof wx.vibrateShort !== "function") {
      return;
    }
    wx.vibrateShort({
      type: "medium"
    });
  },
  handleRecordLongPress(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issue = this.data.form.issueDrafts[index];

    if (!issue || this.data.transcribingIssueId) {
      return;
    }

    this.setData({
      transcribingIssueId: issue.id,
      transcribeStartedAt: Date.now()
    });
    this.triggerRecordVibration();

    recorderManager.start({
      format: "mp3",
      duration: 60000
    });
  },
  handleRecordTouchEnd() {
    if (!this.data.transcribingIssueId) {
      return;
    }

    this.triggerRecordVibration();
    recorderManager.stop();
  },
  async handleIssueTranscription(issueId, tempFilePath, duration) {
    try {
      const result = await transcribeVoiceFile(tempFilePath, {
        duration,
        label: "inspection"
      });
      const issueDrafts = this.data.form.issueDrafts.map((item) => {
        if (item.id !== issueId) {
          return item;
        }

        return {
          ...item,
          isTranscribing: false,
          voiceFilePath: tempFilePath,
          voiceText: mergeSpeechText(item.voiceText, result.text, true)
        };
      });

      this.setData({
        "form.issueDrafts": issueDrafts
      });
      this.persistDraft();
      wx.showToast({
        title: result.mode === "sentence" ? "转写完成" : "转写完成（慢路径）",
        icon: "success"
      });
    } catch (error) {
      const issueDrafts = this.data.form.issueDrafts.map((item) => {
        if (item.id !== issueId) {
          return item;
        }

        return {
          ...item,
          isTranscribing: false,
          voiceFilePath: tempFilePath
        };
      });
      this.setData({
        "form.issueDrafts": issueDrafts
      });
      this.persistDraft();
      const speechError = formatSpeechError(error);
      wx.showToast({
        title: speechError.message,
        icon: "none",
        duration: 3000
      });
    }
  },
  removeIssue(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issueDrafts = (this.data.form.issueDrafts || []).slice();
    const issueExpandedStates = (this.data.issueExpandedStates || []).slice();
    issueDrafts.splice(index, 1);
    issueExpandedStates.splice(index, 1);
    this.setData({
      "form.issueDrafts": issueDrafts,
      issueExpandedStates
    });
    this.persistDraft();
  },
  openAnnotate(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issue = this.data.form.issueDrafts[index];
    if (!issue) {
      return;
    }

    this.persistDraft();
    wx.navigateTo({
      url: `/pages/inspection/annotate/index?sessionKey=${this.data.sessionKey}&issueId=${encodeURIComponent(issue.id)}`
    });
  },
  /** 上传单条草稿的附件，返回补全后的草稿 */
  async uploadOneDraft(item, index) {
    const shouldUploadImageForAnalyze = !hasMeaningfulVoiceText(item.voiceText);

    const imagePath = shouldUploadImageForAnalyze
      ? (item.imagePath.startsWith("cloud://")
        ? item.imagePath
        : await uploadUserFile(item.imagePath, "inspection-images", `${index}.png`))
      : item.imagePath;

    const annotatedImagePath = shouldUploadImageForAnalyze
      ? (item.annotatedImagePath
        ? (item.annotatedImagePath.startsWith("cloud://")
          ? item.annotatedImagePath
          : await uploadUserFile(item.annotatedImagePath, "inspection-annotated-images", `${index}.png`))
        : "")
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
  },

  async uploadAssets() {
    const drafts = this.data.form.issueDrafts || [];

    // 并发上传，但限制同时进行的数量：
    // 弱网下 20 张图一次性并发很容易整体超时。
    const tasks = drafts.map((item, index) => async () => {
      try {
        return await this.uploadOneDraft(item, index);
      } catch (error) {
        // 单张失败不能拖垮整批：先标记，稍后统一重试一次
        console.warn("[inspection-create] 附件上传失败，稍后重试", { index, error });
        return { ...item, __uploadFailed: true };
      }
    });

    let issueDrafts = await runWithConcurrency(tasks, UPLOAD_CONCURRENCY);

    // 对失败的做一次串行重试 —— 工地弱网多为瞬时抖动，重试一次通常就好，
    // 不必为此打断用户。
    const failedIndexes = issueDrafts
      .map((item, index) => (item && item.__uploadFailed ? index : -1))
      .filter((index) => index >= 0);

    if (failedIndexes.length) {
      for (const index of failedIndexes) {
        try {
          issueDrafts[index] = await this.uploadOneDraft(drafts[index], index);
        } catch (error) {
          console.warn("[inspection-create] 重试仍失败", { index, error });
        }
      }
    }

    const stillFailed = issueDrafts.filter((item) => item && item.__uploadFailed).length;

    issueDrafts = issueDrafts.map((item) => {
      if (!item || !item.__uploadFailed) {
        return item;
      }
      const cleaned = { ...item };
      delete cleaned.__uploadFailed;
      return cleaned;
    });

    if (stillFailed) {
      // 说清楚影响面，然后继续 —— 不带图片识别的分析仍比直接失败有用
      wx.showModal({
        title: "部分照片未上传成功",
        content: `有 ${stillFailed} 张照片没能上传，这些照片本次不会参与图片识别。可以先继续，稍后在草稿里重试。`,
        showCancel: false,
        confirmText: "继续"
      });
    }

    const form = {
      ...this.data.form,
      issueDrafts,
      images: issueDrafts
        .filter((item) => !hasMeaningfulVoiceText(item.voiceText))
        .map((item) => item.imagePath)
    };

    this.setData({
      form
    });
    this.persistDraft();

    return form;
  },
  clearAnalyzeTaskPolling() {
    if (this.analyzeTaskPollTimer) {
      clearTimeout(this.analyzeTaskPollTimer);
      this.analyzeTaskPollTimer = null;
    }
  },
  scheduleAnalyzeTaskPolling() {
    this.clearAnalyzeTaskPolling();
    this.analyzeTaskPollTimer = setTimeout(() => {
      this.pollAnalyzeTaskStatus().catch((error) => {
        this.handleAnalyzePollError(error);
      });
    }, ANALYZE_POLL_INTERVAL);
  },

  /**
   * 轮询出错时不要就此停摆。
   *
   * 原实现只在成功路径上重新排程：getInspectionTaskStatus 一旦抛错，
   * catch 里只打印日志，轮询就此断掉。而全屏遮罩还在、没有取消按钮，
   * 用户既看不到进度也退不出去，只能杀掉小程序。
   */
  handleAnalyzePollError(error) {
    console.error("[inspection-create] pollAnalyzeTaskStatus failed", error);

    const failures = (this.analyzePollFailureCount || 0) + 1;
    this.analyzePollFailureCount = failures;

    if (failures > ANALYZE_POLL_MAX_FAILURES) {
      this.clearAnalyzeTaskPolling();
      this.setData({
        analyzing: false,
        analyzeStageIndex: 0,
        analyzeStageText: "",
        analyzeTaskId: ""
      });
      wx.showModal({
        title: "AI 整理中断",
        content: "网络不稳定，没能取回分析结果。照片和草稿都已保留，可以重新点「分析整理」。",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    // 退避重试：把「一次网络抖动 = 永久卡死」变成「多等几秒」
    this.setData({
      analyzeStageText: `网络不稳定，正在重试（第 ${failures} 次）`
    });

    this.clearAnalyzeTaskPolling();
    this.analyzeTaskPollTimer = setTimeout(() => {
      this.pollAnalyzeTaskStatus().catch((nextError) => {
        this.handleAnalyzePollError(nextError);
      });
    }, ANALYZE_POLL_INTERVAL * failures);
  },

  /** 手动中止等待。草稿已持久化，用户可以改用手动补充或重新分析 */
  handleCancelAnalyze() {
    this.clearAnalyzeTaskPolling();
    this.setData({
      analyzing: false,
      analyzeStageIndex: 0,
      analyzeStageText: "",
      analyzeTaskId: ""
    });
    wx.showToast({
      title: "已停止等待，草稿已保留",
      icon: "none"
    });
  },

  async completeAnalyzeSuccess(form, analysis) {
    const draftKey = `inspection-draft-${Date.now()}`;
    wx.setStorageSync(draftKey, {
      form,
      analysis,
      sessionKey: this.data.sessionKey,
      returnContext: this.data.returnContext || null
    });
    this.clearDraft();
    this.clearAnalyzeTaskPolling();
    this.setData({
      analyzing: false,
      analyzeStageIndex: 0,
      analyzeStageText: "",
      analyzeTaskId: ""
    });
    wx.navigateTo({
      url: `/pages/inspection/result/index?draftKey=${draftKey}`
    });
  },
  async pollAnalyzeTaskStatus() {
    if (!this.data.analyzeTaskId) {
      this.clearAnalyzeTaskPolling();
      return "idle";
    }
    const result = await getInspectionTaskStatus(this.data.analyzeTaskId);
    // 成功拿到一次状态就清零失败计数，避免历史上抖动的次数累积
    this.analyzePollFailureCount = 0;
    const totalBatches = result.totalBatches || 0;
    const completedBatches = result.completedBatches || 0;
    if (result.status === "success" && result.analysis) {
      this.setData({
        analyzeStageIndex: 3,
        analyzeStageText: "正在整理问题清单"
      });
      await this.completeAnalyzeSuccess(this.pendingAnalyzeForm || this.data.form, result.analysis);
      return "success";
    }
    if (result.status === "failed") {
      this.clearAnalyzeTaskPolling();
      this.setData({
        analyzing: false,
        analyzeStageIndex: 0,
        analyzeStageText: "",
        analyzeTaskId: ""
      });
      wx.showToast({
        title: result.errorMessage || "AI 分析失败",
        icon: "none"
      });
      return "failed";
    }
    this.setData({
      analyzeStageIndex: 2,
      analyzeStageText: totalBatches
        ? `AI 正在整理（${Math.min(completedBatches, totalBatches)}/${totalBatches} 批）`
        : "AI 正在整理"
    });
    this.scheduleAnalyzeTaskPolling();
    return result.status || "running";
  },
  async handleAnalyze() {
    if (isCoachStep("inspectionAnalyze")) {
      moveCoach("inspectionSubmit");
      this.syncCoachTip();
    }
    // 分开校验，并给出对得上的提示。
    //
    // 原实现是 if (!projectId || !issueDrafts.length) 后统一提示
    // 「请先拍照或添加问题照片」——两个完全不同的原因共用一个消息，
    // 已经加好照片但没选项目的用户会看到完全对不上的提示，无从下手。
    if (this.data.projectLoadError) {
      wx.showModal({
        title: "项目加载失败",
        content: this.data.projectLoadError,
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }

    if (!this.data.form.projectId) {
      const hasProjects = (this.data.projects || []).length > 0;

      if (!hasProjects) {
        // 一个项目都没有时，光提示「请选择项目」是死路，直接给创建入口
        wx.showModal({
          title: "还没有项目",
          content: "每次巡查都要归属到一个项目，请先创建项目。",
          confirmText: "去创建",
          cancelText: "稍后",
          success: (result) => {
            if (result.confirm) {
              wx.navigateTo({
                url: "/pages/project/form/index"
              });
            }
          }
        });
        return;
      }

      wx.showToast({
        title: "请先选择项目",
        icon: "none"
      });
      return;
    }

    if (!this.data.form.issueDrafts.length) {
      wx.showToast({
        title: "请先拍照或添加问题照片",
        icon: "none"
      });
      return;
    }

    this.setData({
      analyzing: true,
      analyzeStageIndex: 1,
      analyzeStageText: "正在准备分析内容"
    });
    let keepAnalyzing = false;

    try {
      const form = await this.uploadAssets();
      const imageRecognitionDraftCount = countImageRecognitionDrafts(form.issueDrafts || []);
      const analyzeStageLabel = imageRecognitionDraftCount > 0 ? "正在分析图片和语音内容" : "正在分析语音转写内容";
      if (imageRecognitionDraftCount > ASYNC_ANALYZE_THRESHOLD) {
        this.pendingAnalyzeForm = form;
        this.setData({
          analyzeStageIndex: 2,
          analyzeStageText: "正在提交 AI 分析任务"
        });
        const task = await createInspectionTask(form);
        this.setData({
          analyzeTaskId: task.taskId || "",
          analyzeStageText: task.totalBatches
            ? `AI 正在整理（0/${task.totalBatches} 批）`
            : "AI 正在整理"
        });
        const taskStatus = await this.pollAnalyzeTaskStatus();
        keepAnalyzing = taskStatus !== "success" && taskStatus !== "failed";
        return;
      }

      this.setData({
        analyzeStageIndex: 2,
        analyzeStageText: analyzeStageLabel
      });
      const analysis = await analyzeInspection(form);
      this.setData({
        analyzeStageIndex: 3,
        analyzeStageText: "正在整理问题清单"
      });
      await this.completeAnalyzeSuccess(form, analysis);
    } catch (error) {
      wx.showToast({
        title: error.message || "分析失败",
        icon: "none"
      });
    } finally {
      if (!keepAnalyzing) {
        this.setData({
          analyzing: false,
          analyzeStageIndex: 0,
          analyzeStageText: "",
          analyzeTaskId: ""
        });
      }
    }
  }
});
