const { listProjects } = require("../../../services/project");
const { analyzeInspection, createInspectionTask, getInspectionTaskStatus } = require("../../../services/inspection");
const { uploadUserFile } = require("../../../services/cloud");
const { transcribeVoiceFile, mergeSpeechText, formatSpeechError } = require("../../../services/speech");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { runWithConcurrency } = require("../../../utils/async");
const { keepLocalFile, uploadDraftMedia } = require("../../../services/inspection-media");
const { readDraft, writeDraft, patchDraft } = require("../../../utils/inspection-draft");
const { identity } = require("../../../utils/inspection-model");

const recorderManager = wx.getRecorderManager();
const MAX_ISSUE_DRAFTS = 20;
const SINGLE_PICK_LIMIT = 9;
/** 附件上传的并发上限：弱网下并发太高会让整批一起超时 */
const UPLOAD_CONCURRENCY = 3;
const PENDING_PROJECT_KEY = "pendingInspectionProject";
const LATEST_INSPECTION_DRAFT_META_KEY = "latestInspectionDraftMeta";
/**
 * 超过这个数量就走异步任务路径。
 *
 * 设为 0：只要有需要图片识别的草稿，一律走异步任务。
 * 一次图片识别请求本身可能要几十秒，同步路径会让用户盯着一个不动的
 * 全屏遮罩（实测踩到超时）；异步路径能显示「AI 正在整理（2/5 批）」的进度，
 * 且服务端每轮有时间预算，单次调用不会顶到云函数上限。
 */
const ASYNC_ANALYZE_THRESHOLD = 0;
const ANALYZE_POLL_INTERVAL = 1500;
/** 轮询连续失败多少次后停止等待（每次失败会退避重试） */
const ANALYZE_POLL_MAX_FAILURES = 5;
const ISSUE_SECTION_TITLES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];

function createIssueDraft(filePath) {
  return {
    id: `${Date.now()}-${Math.random()}`,
    imagePath: filePath,
    annotations: [],
    annotationCount: 0,
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

// The canvas returns to this page with a freshly written draft. Keep the
// compact counts used by the view as explicit presentation state instead of
// repeatedly asking the renderer to evaluate nested array lengths while a
// wx:for subtree is being patched. The source of truth remains issueDrafts.
function normalizeIssueDrafts(issueDrafts = []) {
  return issueDrafts.map((item) => ({
    ...item,
    annotationCount: (item.annotations || []).length
  }));
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

// 草稿形状统一定义在 utils/inspection-draft.js。
// 此前创建页存 { form, returnContext }、标注页读扁平结构，导致标注永远打不开。
const {
  createDraftSnapshot,
  extractDraftForm,
  extractDraftReturnContext
} = require("../../../utils/inspection-draft");

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
  return text.includes("cancel");
}

function isPickerPermissionDenied(error) {
  const text = `${(error && error.errMsg) || (error && error.message) || ""}`.toLowerCase();
  return /auth deny|authorize|permission|denied|reject|拒绝|未授权/.test(text);
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
    issueDraftCount: 0,
    showSupplementFields: false,
    analyzing: false,
    analyzeStageText: "",
    analyzeStageIndex: 0,
    analyzeTaskId: "",
    returnContext: null,
    issueSectionTitles: ISSUE_SECTION_TITLES,
    form: createInitialForm(),
  },
  async onLoad(query) {
    this.initializing=true;
    try {if(typeof getApp === "function" && getApp().ensureReady) await getApp().ensureReady();}
    catch(e){this.setData({projectLoadError:e.message});return;}
    this.initializing=false;
    // recorderManager 是全局单例，必须成对注册/解绑（见 onUnload），
    // 否则页面每次进入都会再挂一个 onStop，同一段录音被重复转写。
    this.boundRecorderStop = async (result) => {
      const transcribingIssueId = this.data.transcribingIssueId;
      if(this.recordCancelled){this.setData({transcribingIssueId:"",recordCancelArmed:false});wx.showToast({title:"录音已取消",icon:"none"});return;}

      if (!transcribingIssueId) {
        return;
      }

      if (!result || !result.tempFilePath) {
        this.setData({ transcribingIssueId: "" });
        wx.showToast({
          title: "没有录到声音，请重试",
          icon: "none"
        });
        return;
      }

      const duration = Math.max(0, Date.now() - (this.data.transcribeStartedAt || 0));
      try { result.tempFilePath = await keepLocalFile(result.tempFilePath); }
      catch(e){wx.showModal({title:"录音未保存",content:e.message,showCancel:false});this.setData({transcribingIssueId:""});return;}

      const issueDrafts = this.data.form.issueDrafts.map(item => {
        if (item.id === transcribingIssueId) {
          return { ...item, isTranscribing: true, voiceFilePath: result.tempFilePath, voiceFileId:"",voiceStorageFileId:"",speechError:"" };
        }
        return item;
      });

      this.setData({
        transcribingIssueId: "",
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length
      });

      this.triggerRecordVibration();
      this.persistDraft();
      this.handleIssueTranscription(transcribingIssueId, result.tempFilePath, duration);
    };

    // recorderManager.start 没有 success/fail 回调，失败只能靠 onError 感知。
    // 原来没监听，麦克风权限被拒后会一直停在录音状态，用户退不出来。
    this.boundRecorderError = (error) => {
      console.error("[inspection-create] recorder error", error);
      this.setData({ transcribingIssueId: "" });

      const text = `${(error && error.errMsg) || (error && error.message) || ""}`;
      if (/auth deny|authorize|permission|拒绝|未授权/i.test(text)) {
        wx.showModal({
          title: "需要麦克风权限",
          content: "可以直接输入文字；也可在设置中允许麦克风后重试录音。",
          confirmText: "去设置",
          cancelText: "知道了",
          success: (res) => {
            if (res.confirm && typeof wx.openSetting === "function") {
              wx.openSetting({});
            }
          }
        });
        return;
      }

      wx.showToast({
        title: "录音失败，请重试",
        icon: "none"
      });
    };

    recorderManager.onStop(this.boundRecorderStop);
    recorderManager.onError(this.boundRecorderError);

    const initialReturnContext = decodeReturnContext(query.returnContext) || null;
    this.explicitProjectId = query.projectId || (initialReturnContext && initialReturnContext.projectId) || "";
    this.setData({"form.projectId":this.explicitProjectId});
    if (query.sessionKey) {
      this.setData({
        sessionKey: query.sessionKey,
        returnContext: initialReturnContext
      });
      this.restoreDraft();
      setTimeout(() => {
        this.loadProjects(this.explicitProjectId);
      }, 0);
      return;
    }

    this.setData({
      sessionKey: this.createSessionKey(),
      returnContext: initialReturnContext
    });
    setTimeout(() => {
      this.loadProjects(this.explicitProjectId);
    }, 0);
  },
  async onShow() {
    if(this.initializing)return;
    this.ownsDraft = true;
    this.restoreDraft();
    if(readDraft(this.data.sessionKey).submission?.requestId){
      wx.redirectTo({url:"/pages/inspection/result/index?sessionKey="+encodeURIComponent(this.data.sessionKey)});return;
    }
    // Every edit is already persisted. Do not install a native Back guard:
    // some clients keep it alive after this page is hidden, so it can block
    // the next page's Back action with an unrelated confirmation.
    if (this.data.analyzing && this.data.analyzeTaskId) {
      this.waitingForAnalysis=true;
      this.pendingInputVersion=readDraft(this.data.sessionKey).inputVersion;
      this.scheduleAnalyzeTaskPolling();
    }
  },
  onHide() {
    this.waitingForAnalysis = false;
    if(this.data.transcribingIssueId)this.handleRecordCancel();
    this.persistDraft();
    this.ownsDraft = false;
    this.clearAnalyzeTaskPolling();
    // The native unload guard survives navigation in Developer Tools. Do not
    // let the hidden capture page intercept annotation/review navigation.
    if (typeof wx.disableAlertBeforeUnload === "function") {
      wx.disableAlertBeforeUnload();
    }
  },
  onUnload() {
    this.pickerEpoch = (this.pickerEpoch || 0) + 1;
    clearTimeout(this.pickerTimer);
    this.waitingForAnalysis = false;
    this.persistDraft();
    this.clearAnalyzeTaskPolling();

    // 与 onLoad 成对解绑：recorderManager 是全局单例，
    // 不解绑会导致下一次进入本页时同一段录音被重复处理
    if (this.boundRecorderStop && typeof recorderManager.offStop === "function") {
      recorderManager.offStop(this.boundRecorderStop);
    }
    if (this.boundRecorderError && typeof recorderManager.offError === "function") {
      recorderManager.offError(this.boundRecorderError);
    }
    this.boundRecorderStop = null;
    this.boundRecorderError = null;
    if (typeof wx.disableAlertBeforeUnload === "function") {
      wx.disableAlertBeforeUnload();
    }
  },
  persistDraft() {
    if(this.initializing)return false;
    // Annotation/review owns the stored session while capture is hidden.
    // A later unload/recompile must not overwrite it with this page's stale form.
    if (this.ownsDraft === false) return true;
    if(wx.getStorageSync(this.data.sessionKey + ":complete")) return true;
    if (!this.data.sessionKey) {
      return;
    }

    try {
      writeDraft(this.data.sessionKey, this.data.form, this.data.returnContext);
    } catch(e) { wx.showModal({title:"草稿保存失败",content:e.message || "请释放本机空间后重试，请勿关闭",showCancel:false}); return false; }
    if (!hasMeaningfulDraftContent(this.data.form)) {
      const latestDraftMeta = this.getLatestDraftMeta();
      if (latestDraftMeta && latestDraftMeta.sessionKey === this.data.sessionKey) {
        wx.removeStorageSync(LATEST_INSPECTION_DRAFT_META_KEY);
      }
    }
    return true;
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
  },
  createSessionKey() {
    return identity("inspection-create");
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
      issueDraftCount: 0,
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
  },
  restoreDraft() {
    if (!this.data.sessionKey) {
      return false;
    }

    const cached = readDraft(this.data.sessionKey);
    const cachedForm = extractDraftForm(cached);
    const cachedReturnContext = extractDraftReturnContext(cached);
    if (cachedForm && this.explicitProjectId && cachedForm.projectId !== this.explicitProjectId) {
      this.setData({projectLoadError:"草稿与当前项目不一致，请返回重新选择",sessionKey:""});
      return false;
    }
    if (cachedForm && cachedForm.issueDrafts) {
      const issueDrafts = normalizeIssueDrafts(cachedForm.issueDrafts);
      this.setData({
        form: {
          ...this.data.form,
          ...cachedForm,
          issueDrafts
        },
        returnContext: cachedReturnContext || this.data.returnContext || null,
        analyzeTaskId: cached.taskId || "",
        issueDraftCount: issueDrafts.length,
        issueExpandedStates: buildIssueExpandedStates(issueDrafts, this.data.issueExpandedStates),
        showSupplementFields: Boolean((cachedForm.title || "").trim() || (cachedForm.note || "").trim())
      });
      return true;
    }
    return false;
  },
  hasUnsavedDraft() {
    return hasMeaningfulDraftContent(this.data.form || {});
  },
  async loadProjects(defaultProjectId) {
    this.setData({
      loadingProjects: true,
      projectLoadError: ""
    });

    try {
      const result = await listProjects({ pageSize: 100 });
      const projects = result.list || [];
      const projectId = this.data.form.projectId || defaultProjectId || this.explicitProjectId || "";
      const projectIndex = projects.findIndex((item) => item._id === projectId);
      if (projectId && projectIndex < 0) throw new Error("该项目已删除或无权限访问，请返回；原草稿已保留");

      this.setData({
        projects,
        projectIndex,
        currentProjectNameText: (projects[projectIndex] && projects[projectIndex].name) || "请选择项目",
        "form.projectId": projectId,
        "form.projectName": (projects[projectIndex] && projects[projectIndex].name) || ""
      });
      this.persistDraft();
    } catch (error) {
      this.setData({
        projects: [],
        projectIndex: 0,
        currentProjectNameText: "项目加载失败",
        projectLoadError: error.message || "项目加载失败"
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
    const { preserveDraft = true, goHome = false } = options;
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
  handleReturn(){if(this.persistDraft())this.leaveCurrentPage({preserveDraft:true});},
  handleHomeTap(){if(this.persistDraft())this.leaveCurrentPage({preserveDraft:true,goHome:true});},
  async handleProjectChange(event) {
    if (this.data.pickingImages) { wx.showToast({title:"请先完成或取消选图",icon:"none"}); return; }
    const projectIndex = Number(event.detail.value);
    const project = this.data.projects[projectIndex] || {};
    if (!project._id || project._id === this.data.form.projectId) return;
    if (readDraft(this.data.sessionKey).submission?.requestId) return;
    if (this.hasUnsavedDraft()) {
      const choice = await new Promise(resolve=>wx.showModal({title:"更换记录所属项目？",content:`已添加的照片和说明将移至“${project.name}”。请确认项目归属。`,success:resolve,fail:()=>resolve({confirm:false})}));
      if (!choice.confirm) return;
    }
    this.explicitProjectId = project._id;
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
    if (this.data.pickingImages) return;
    if(!this.data.sessionKey || !this.data.form.projectId || this.data.loadingProjects || this.data.projectLoadError){wx.showToast({title:"请先确认记录所属项目",icon:"none"});return;}
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
    const projectId = this.data.form.projectId;
    const sessionKey = this.data.sessionKey;
    const epoch = this.pickerEpoch = (this.pickerEpoch || 0) + 1;
    const isCurrent = () => page.pickerEpoch === epoch && page.data.sessionKey === sessionKey && page.data.form.projectId === projectId;
    const finish = (error = "") => {
      if (!isCurrent()) return;
      clearTimeout(page.pickerTimer);
      page.setData({pickingImages:false,pickerError:error});
    };
    this.setData({pickingImages:true,pickerError:""});
    this.pickerTimer = setTimeout(() => {
      finish("选图未返回。可重新打开相册，或先保留草稿返回。");
      if (isCurrent()) page.pickerEpoch += 1;
    }, 120000);

    const commitPickedPaths = async (paths) => {
      if (!isCurrent()) return;
      const list = (paths || []).filter(Boolean);
      if (!list.length) {
        finish();
        return;
      }
      try { for(let i=0;i<list.length;i++)list[i]=await keepLocalFile(list[i]); }
      catch(e){finish(e.message || "照片未保存，请重试");return;}
      if (!isCurrent()) return;
      const issueDrafts = normalizeIssueDrafts((page.data.form.issueDrafts || []).concat(list.map((p) => createIssueDraft(p))));
      const issueExpandedStates = buildExpandedStatesAfterAppend(page.data.form.issueDrafts.length, list.length);

      page.setData({
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length,
        issueExpandedStates
      });
      page.persistDraft();
      finish();

      if (issueDrafts.length >= MAX_ISSUE_DRAFTS) {
        wx.showToast({
          title: "已达到20张上限",
          icon: "none"
        });
      }
    };

    const handlePickerFail = (error, sourceType) => {
      if (!isCurrent()) return;
      finish(isUserCancelledPrivacyOrPicker(error) ? "" : "无法打开相册或相机，请重试或检查授权。");
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
      if (isPickerPermissionDenied(error)) {
        wx.showModal({
          title: sourceType === "camera" ? "无法使用相机" : "无法访问相册",
          content: sourceType === "camera"
            ? "可以先从相册选择照片，或稍后在微信设置中开启相机权限。"
            : "请在微信设置中允许访问相册后重试；已填写的文字不会丢失。",
          confirmText: sourceType === "camera" ? "从相册选择" : "去设置",
          cancelText: "稍后处理",
          success: (result) => {
            if (!result.confirm) return;
            if (sourceType === "camera") {
              openIssueImagePicker("album");
            } else if (typeof wx.openSetting === "function") {
              wx.openSetting({});
            }
          }
        });
        return;
      }
      wx.showToast({
        title: "无法打开相册或相机",
        icon: "none"
      });
    };

    const openIssueImagePicker = (sourceType) => {
      // 这里最终只接收照片。优先使用 chooseImage：它在真机和开发者工具
      // 的系统相册/文件选择回调都更稳定，并能明确请求原图，避免标注基准在
      // 选择时被压缩后的临时图悄悄改变。保留 chooseMedia 仅作旧基础库兜底。
      if (typeof wx.chooseImage === "function") {
        wx.chooseImage({
          count,
          sizeType: ["original"],
          sourceType: [sourceType],
          success(res) {
            commitPickedPaths(res.tempFilePaths || []);
          },
          fail(error) {
            handlePickerFail(error, sourceType);
          }
        });
        return;
      }

      if (typeof wx.chooseMedia !== "function") {
        finish("当前微信版本不支持选图，请升级后重试。");
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
          handlePickerFail(error, sourceType);
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
          return;
        }
        finish();
      },
      fail: () => finish()
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
      result = typeof wx.chooseImage === "function"
        ? await new Promise((resolve, reject) => wx.chooseImage({
          count: 1,
          sizeType: ["original"],
          sourceType: ["album", "camera"],
          success: (value) => resolve({tempFiles:(value.tempFilePaths || []).map(tempFilePath=>({tempFilePath}))}),
          fail: reject
        }))
        : await wx.chooseMedia({
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
      if (isPickerPermissionDenied(error)) {
        wx.showModal({
          title: "无法更换照片",
          content: "请在微信设置中允许使用相机或相册后重试；当前照片、标注和文字仍会保留。",
          confirmText: "去设置",
          cancelText: "保留当前照片",
          success: (value) => {
            if (value.confirm && typeof wx.openSetting === "function") wx.openSetting({});
          }
        });
        return;
      }
      wx.showToast({title:"无法更换照片",icon:"none"});
      return;
    }

    const tempFile = result.tempFiles && result.tempFiles[0];
    if (!tempFile) {
      return;
    }

    let savedPath;
    try { savedPath=await keepLocalFile(tempFile.tempFilePath); }
    catch(e){wx.showModal({title:"照片未保存",content:e.message,showCancel:false});return;}
    this.setData({
      [`form.issueDrafts[${index}].imagePath`]: savedPath,
      [`form.issueDrafts[${index}].localImagePath`]: savedPath,
      [`form.issueDrafts[${index}].localAnnotatedImagePath`]: "",
      [`form.issueDrafts[${index}].sourceOriginalImagePath`]: "",
      [`form.issueDrafts[${index}].localOriginalImagePath`]: "",
      [`form.issueDrafts[${index}].annotationStage`]: null,
      [`form.issueDrafts[${index}].annotationDirty`]: false,
      [`form.issueDrafts[${index}].mediaRevision`]: (this.data.form.issueDrafts[index].mediaRevision || 1)+1,
      [`form.issueDrafts[${index}].annotatedImagePath`]: "",
      [`form.issueDrafts[${index}].annotations`]: [],
      [`form.issueDrafts[${index}].annotationCount`]: 0
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

    if (!issue || issue.isTranscribing || this.data.transcribingIssueId) {
      return;
    }

    this.recordCancelled=false;
    this.recordStartY=event.touches && event.touches[0] ? event.touches[0].clientY : 0;
    this.setData({
      recordCancelArmed:false,
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

    this.recordCancelled=!!this.data.recordCancelArmed;
    this.triggerRecordVibration();
    recorderManager.stop();
  },
  handleRecordMove(event){
    if(!this.data.transcribingIssueId || !event.touches?.[0])return;
    this.setData({recordCancelArmed:this.recordStartY-event.touches[0].clientY>60});
  },
  handleRecordCancel(){this.recordCancelled=true;recorderManager.stop();},
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
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length
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
          voiceFilePath: tempFilePath,
          speechError:"转写失败：可以直接输入文字，录音已保留。"
        };
      });
      this.setData({
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length
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
    wx.showModal({title:"删除这张照片？",content:"对应标注和问题也会从本次记录移除。",confirmText:"删除",success:r=>{if(r.confirm)this.removeIssueConfirmed(event);}});
  },
  removeIssueConfirmed(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issueDrafts = (this.data.form.issueDrafts || []).slice();
    const issueExpandedStates = (this.data.issueExpandedStates || []).slice();
    issueDrafts.splice(index, 1);
    issueExpandedStates.splice(index, 1);
    this.setData({
      "form.issueDrafts": issueDrafts,
      issueDraftCount: issueDrafts.length,
      issueExpandedStates
    });
    this.persistDraft();
  },
  moveIssue(event){
    const index=Number(event.currentTarget.dataset.index),step=Number(event.currentTarget.dataset.step),target=index+step;
    const rows=this.data.form.issueDrafts.slice();if(target<0||target>=rows.length)return;
    [rows[index],rows[target]]=[rows[target],rows[index]];
    this.setData({"form.issueDrafts":rows,issueDraftCount:rows.length,issueExpandedStates:rows.map((_,i)=>i===target)});this.persistDraft();
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
    const form = await uploadDraftMedia(this.data.form, async form => {
      this.setData({form});
      if (!this.persistDraft()) throw new Error("草稿保存失败");
    });
    this.setData({form});
    if (!this.persistDraft()) throw new Error("草稿保存失败");
    return form;
  },
  async handleManualReview() {
    if (!this.data.form.projectId || !this.data.form.issueDrafts.length) {
      wx.showToast({title:"请先选择项目并添加照片",icon:"none"}); return;
    }
    const cached=readDraft(this.data.sessionKey);
    if(cached.review) {
      wx.navigateTo({url:"/pages/inspection/result/index?sessionKey="+encodeURIComponent(this.data.sessionKey)});return;
    }
    const items=this.data.form.issueDrafts.flatMap((p,i)=>p.voiceText && p.voiceText.trim() ? [{
      id:identity("issue"),sourcePhotoId:p.id,sourceIndex:i,description:p.voiceText,suggestion:"",severity:"normal",responsibleParty:"pending"
    }]:[]);
    await this.completeAnalyzeSuccess(this.data.form,{items,summary:"人工记录，请核对照片与说明；未记录问题不代表验收合格。",aiMode:"manual"});
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
        analyzeTaskId: this.data.analyzeTaskId || ""
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
    this.waitingForAnalysis=false;
    this.clearAnalyzeTaskPolling();
    this.setData({
      analyzing: false,
      analyzeStageIndex: 0,
      analyzeStageText: "",
      analyzeTaskId: this.data.analyzeTaskId || ""
    });
    wx.showToast({
      title: "已停止等待，草稿已保留",
      icon: "none"
    });
  },

  async completeAnalyzeSuccess(form, analysis) {
    this.setData({form});
    if (!this.persistDraft()) throw new Error("草稿保存失败");
    patchDraft(this.data.sessionKey,{phase:"review",analysis});
    this.clearAnalyzeTaskPolling();
    this.setData({analyzing:false,analyzeStageIndex:0,analyzeStageText:""});
    wx.navigateTo({url:"/pages/inspection/result/index?sessionKey="+encodeURIComponent(this.data.sessionKey)});
  },
  async pollAnalyzeTaskStatus() {
    if (!this.data.analyzeTaskId) {
      this.clearAnalyzeTaskPolling();
      return "idle";
    }
    const result = await getInspectionTaskStatus(this.data.analyzeTaskId, true);
    if(!this.waitingForAnalysis)return "paused";
    if(this.pendingInputVersion!==readDraft(this.data.sessionKey).inputVersion){this.setData({analyzing:false});return "stale";}
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
        analyzeTaskId: this.data.analyzeTaskId || ""
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
    if(this.data.analyzing)return;
    const stored=readDraft(this.data.sessionKey);
    if(stored.review){this.handleManualReview();return;}
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

    this.waitingForAnalysis=true;
    this.pendingInputVersion=stored.inputVersion;
    this.setData({
      analyzing: true,
      analyzeStageIndex: 1,
      analyzeStageText: "正在准备分析内容"
    });
    let keepAnalyzing = false;

    try {
      const form = await this.uploadAssets();
      const saved = readDraft(this.data.sessionKey);
      if(saved.taskId){ this.setData({analyzeTaskId:saved.taskId}); this.pendingAnalyzeForm=form; const status=await this.pollAnalyzeTaskStatus(); keepAnalyzing=status!=="success" && status!=="failed"; return; }
      const imageRecognitionDraftCount = countImageRecognitionDrafts(form.issueDrafts || []);
      const analyzeStageLabel = imageRecognitionDraftCount > 0 ? "正在分析图片和语音内容" : "正在分析语音转写内容";
      if (form.issueDrafts.length > 0) {
        this.pendingAnalyzeForm = form;
        this.setData({
          analyzeStageIndex: 2,
          analyzeStageText: "正在提交 AI 分析任务"
        });
        const requestId = saved.analysisRequestId || identity("analysis");
        patchDraft(this.data.sessionKey,{analysisRequestId:requestId,phase:"analyzing"});
        const task = await createInspectionTask({...form,requestId,inputVersion:saved.inputVersion || 1});
        patchDraft(this.data.sessionKey,{taskId:task.taskId,phase:"analyzing"});
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
      // 用弹窗而不是 toast：toast 会自己消失，用户很可能没看到，
      // 然后以为「点了没反应」。照片与草稿都在，说明清楚可以重试。
      console.error("[inspection-create] analyze failed", error);
      wx.showModal({
        title: "AI 整理失败",
        content: `${(error && error.message) || "未知错误"}\n\n照片与草稿都已保留，可以直接重新点「分析整理」。`,
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
      if (!keepAnalyzing) {
        this.setData({
          analyzing: false,
          analyzeStageIndex: 0,
          analyzeStageText: "",
          analyzeTaskId: this.data.analyzeTaskId || ""
        });
      }
    }
  }
});
