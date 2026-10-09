const { listProjects } = require("../../../services/project");
const { coachData, coachMethodsMulti } = require("../../../utils/coach-page");
const {
  analyzeInspection,
  createInspectionTask,
  readInspectionTaskStatus,
  advanceInspectionTask,
  cancelInspectionTask
} = require("../../../services/inspection");
const { transcribeVoiceFile, mergeSpeechText, formatSpeechError } = require("../../../services/speech");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { runWithConcurrency } = require("../../../utils/async");
const { keepLocalFile, uploadDraftMedia } = require("../../../services/inspection-media");
const { readDraft, writeDraft, patchDraft } = require("../../../utils/inspection-draft");
const { identity, buildManualReviewItems, getPhotoDisplayPath } = require("../../../utils/inspection-model");
const { isCloudFileId, resolveCloudFileUrls } = require("../../../services/cloud-media");

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
// Allow one expired server lease (180s) to recover, but never wait forever.
const ANALYZE_NO_PROGRESS_LIMIT = 210000;
/** 轮询连续失败多少次后停止等待（每次失败会退避重试） */
const ANALYZE_POLL_MAX_FAILURES = 5;
const ISSUE_SECTION_TITLES = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];

function createIssueDraft(filePath) {
  return {
    id: `${Date.now()}-${Math.random()}`,
    imagePath: filePath,
    annotations: [],
    annotationCount: 0,
    annotationRevision: 0,
    analysisMode: "pending",
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
    // Cloud file IDs are for persistence and submission, not <image src>.
    // Keep the on-device source as the preview so uploading for AI does not
    // make the photo disappear while the user is still in the capture flow.
    displayImagePath: getPhotoDisplayPath(item),
    annotationCount: (item.annotations || []).length,
    analysisModeResolved: item.analysisMode === "ai"
      ? "ai"
      : ["manual", "pending"].includes(item.analysisMode)
        ? item.analysisMode
        : (hasMeaningfulVoiceText(item.voiceText) ? "manual" : "ai")
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
  return (issueDrafts || []).filter((item) => Boolean(item.imagePath) && (
    item.analysisMode === "ai" ||
    (!['manual', 'pending'].includes(item.analysisMode) && !hasMeaningfulVoiceText(item.voiceText))
  )).length;
}

function countTextOrganizationDrafts(issueDrafts = []) {
  return issueDrafts.filter(photo => photo.organizeText === true && photo.analysisMode !== 'ai' && hasMeaningfulVoiceText(photo.voiceText)).length;
}

function getAnalyzePanelTitle(issueDrafts = []) {
  const hasImageRecognition = countImageRecognitionDrafts(issueDrafts) > 0;
  const hasTextOrganization = countTextOrganizationDrafts(issueDrafts) > 0;
  if (hasImageRecognition && hasTextOrganization) return "正在整理现场记录";
  if (hasImageRecognition) return "正在识别现场照片";
  return "正在整理现场说明";
}

function getNextActionLabel(issueDrafts = []) {
  if (issueDrafts.some(photo => hasMeaningfulVoiceText(photo.voiceText))) return "整理说明并核对";
  return "进入人工核对";
}

function bindAnalysisItemsToPhotos(items = [], photos = []) {
  return (items || []).map((item) => ({
    ...item,
    sourcePhotoId: item.sourcePhotoId || (photos[item.sourceIndex] && photos[item.sourceIndex].id) || ""
  }));
}

function mergeReanalyzedReview(draft = {}, analysis = {}, form = {}) {
  const review = draft.review;
  if (!review || !review.stale) return null;
  const photos = form.issueDrafts || [];
  const photoIds = new Set(photos.map(photo => photo.id));
  const staleIds = new Set((review.stalePhotoIds && review.stalePhotoIds.length)
    ? review.stalePhotoIds
    : photos.map(photo => photo.id));
  const keepUnchanged = item => item.sourcePhotoId && photoIds.has(item.sourcePhotoId) && !staleIds.has(item.sourcePhotoId);
  const nextAiItems = bindAnalysisItemsToPhotos(analysis.items || [], photos)
    .filter(item => item.sourcePhotoId && staleIds.has(item.sourcePhotoId));
  // Field edits belong to the inspector, not to the model. Match only stable
  // item/annotation IDs or an exact source span, never array position.
  const editedItems = (review.items || []).filter(item => photoIds.has(item.sourcePhotoId) && staleIds.has(item.sourcePhotoId) && (item.editedFields || []).length);
  const preserved = new Set();
  const refreshedItems = nextAiItems.map(item => {
    const previous = editedItems.find(old => old.sourcePhotoId === item.sourcePhotoId && (
      old.id === item.id || (old.annotationId && old.annotationId === item.annotationId) ||
      (old.sourceQuote && old.sourceQuote === item.sourceQuote)
    ));
    if (!previous) return item;
    preserved.add(previous.id);
    const result = {...item, id:previous.id, editedFields:previous.editedFields};
    previous.editedFields.forEach(field => {result[field]=previous[field];});
    return result;
  });
  editedItems.filter(item => !preserved.has(item.id)).forEach(item => refreshedItems.push({...item,needsReview:true}));
  const items = (review.items || []).filter(keepUnchanged).concat(refreshedItems);
  const originalItems = (review.originalItems || []).filter(keepUnchanged).concat(nextAiItems);
  const summaryEdited = review.summaryEdited === true;
  return {
    items,
    originalItems,
    summary: summaryEdited ? review.summary : "",
    summaryEdited,
    stale: false,
    stalePhotoIds: []
  };
}

function mergeReanalyzedObservations(draft = {}, analysis = {}, form = {}) {
  const review=draft.review;
  if(!review || !review.stale)return analysis.observations || [];
  const photos=form.issueDrafts || [];
  const photoIds=new Set(photos.map(photo=>photo.id).filter(Boolean));
  const staleIds=new Set((review.stalePhotoIds && review.stalePhotoIds.length)
    ? review.stalePhotoIds
    : photos.map(photo=>photo.id));
  const previous=(draft.analysis && draft.analysis.observations) || [];
  const unchanged=previous.filter(item=>item.sourcePhotoId && photoIds.has(item.sourcePhotoId) && !staleIds.has(item.sourcePhotoId));
  const refreshed=(analysis.observations || []).filter(item=>item.sourcePhotoId && staleIds.has(item.sourcePhotoId));
  return unchanged.concat(refreshed);
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

function normalizePickerResult(result = {}) {
  const paths = Array.isArray(result.tempFilePaths) ? result.tempFilePaths : [];
  const files = Array.isArray(result.tempFiles)
    ? result.tempFiles.map(file => file && (file.tempFilePath || file.path)).filter(Boolean)
    : [];
  return Array.from(new Set(paths.concat(files).filter(Boolean)));
}

/**
 * 统一照片入口。
 *
 * chooseMedia 是真机当前基础库面向相册/相机的主入口。
 * 微信开发者工具的 macOS 文件选择器在部分版本里能完成选择却不回调
 * chooseMedia；仅在 platform=devtools 时把 chooseImage 提到前面，避免把
 * 开发工具的兼容问题带进真实用户路径。两条路径都归一化为本地照片路径。
 */
function choosePhotoFiles({ count = 1, sourceType = ["album", "camera"] } = {}) {
  // getDeviceInfo describes the host device and can report macOS in DevTools.
  // getAppBaseInfo describes the mini-program runtime, which is what we need
  // to decide whether to use the DevTools-compatible legacy picker.
  let runtimePlatform = "";
  try {
    if (typeof wx.getAppBaseInfo === "function") {
      runtimePlatform = String((wx.getAppBaseInfo() || {}).platform || "").toLowerCase();
    }
  } catch (_error) {}
  // If runtime metadata is unavailable, keep the standard chooseMedia order.
  // Never fall back to getSystemInfoSync: it is deprecated and can report the
  // host Mac instead of the mini-program runtime in Developer Tools.
  const isDevtools = runtimePlatform === "devtools";
  const chooseLegacyFirst = isDevtools && typeof wx.chooseImage === "function";
  if (chooseLegacyFirst) {
    return new Promise((resolve, reject) => wx.chooseImage({
      count,
      sizeType: ["original"],
      sourceType,
      success: (result) => resolve(normalizePickerResult(result)),
      fail: reject
    }));
  }
  if (typeof wx.chooseMedia === "function") {
    return new Promise((resolve, reject) => wx.chooseMedia({
      count,
      mediaType: ["image"],
      sourceType,
      success: (result) => resolve(normalizePickerResult(result)),
      fail: reject
    }));
  }
  if (typeof wx.chooseImage === "function") {
    return new Promise((resolve, reject) => wx.chooseImage({
      count,
      sizeType: ["original"],
      sourceType,
      success: (result) => resolve(normalizePickerResult(result)),
      fail: reject
    }));
  }
  return Promise.reject(new Error("当前微信版本不支持选图，请升级后重试。"));
}

Page({
  data: {
    ...coachData(),
    projects: [],
    projectIndex: 0,
    currentProjectNameText: "请选择项目",
    projectLoadError: "",
    loadingProjects: false,
    pickingImages: false,
    pickerSourceType: "",
    pickerStatusText: "",
    pickerError: "",
    failedPhotoPreviewId: "",
    photoChoiceIds: [],
    photoChoiceOpen: false,
    sessionKey: "",
    recordingIssueId: "",
    transcribingIssueId: "",
    transcribeStartedAt: 0,
    issueExpandedStates: [],
    issueDraftCount: 0,
    nextActionLabel: "进入人工核对",
    analyzing: false,
    analyzePanelTitle: "正在整理现场记录",
    analyzeStageText: "",
    analyzeStageIndex: 0,
    analyzeTaskId: "",
    analyzeCompletedPhotos: 0,
    analyzeTotalPhotos: 0,
    analyzePhotoProgressText: "",
    analyzeProgressPercent: 0,
    analyzeProgressLabel: "进度",
    analyzeError: "",
    returnContext: null,
    issueSectionTitles: ISSUE_SECTION_TITLES,
    form: createInitialForm(),
  },
  async onLoad(query) {
    this.initializing=true;
    try {if(typeof getApp === "function" && getApp().ensureReady) await getApp().ensureReady();}
    catch(e){this.setData({projectLoadError:e.message});return;}
    this.initializing=false;
    // Read existing permission early without prompting; recording still starts
    // only on the user's press. This removes a settings round trip per take.
    if(typeof wx.getSetting==='function')wx.getSetting({success:setting=>{this.recordPermissionReady=setting.authSetting?.['scope.record']===true;},fail:()=>{}});
    this.boundRecorderStart=()=>{
      if(!this.recordPressActive){this.recordCancelled=true;recorderManager.stop();return;}
      this.recorderStarted=true;
      this.setData({transcribeStartedAt:Date.now()});
      this.triggerRecordVibration();
    };
    // recorderManager 是全局单例，必须成对注册/解绑（见 onUnload），
    // 否则页面每次进入都会再挂一个 onStop，同一段录音被重复转写。
    this.boundRecorderStop = async (result) => {
      this.recorderStarted=false;
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

      const duration = Number(result.duration) || Math.max(0, Date.now() - (this.data.transcribeStartedAt || 0));
      if(duration<600){this.setData({transcribingIssueId:""});wx.showToast({title:'录音太短，请按住说话',icon:'none'});return;}
      try { result.tempFilePath = await keepLocalFile(result.tempFilePath); }
      catch(e){wx.showModal({title:"录音未保存",content:e.message,showCancel:false});this.setData({transcribingIssueId:""});return;}

      const issueDrafts = this.data.form.issueDrafts.map(item => {
        if (item.id === transcribingIssueId) {
          return { ...item, isTranscribing: true, voiceFilePath: result.tempFilePath, voiceDuration: duration, voiceFileId:"",voiceStorageFileId:"",speechError:"" };
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
      this.recorderStarted=false;
      this.recordPressActive=false;
      console.error("[inspection-create] recorder error", error);
      this.setData({ transcribingIssueId: "" });

      const text = `${(error && error.errMsg) || (error && error.message) || ""}`;
      if (/auth deny|authorize|permission|拒绝|未授权/i.test(text)) {
        this.recordPermissionReady=false;
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
    if(typeof recorderManager.onStart==='function')recorderManager.onStart(this.boundRecorderStart);

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
    this.syncCoach();
    // 草稿恢复完、照片渲染出来之后再同步一次，避免用「还没有照片」的旧前提下判断
    setTimeout(() => this.syncCoach(), 1200);
    if(this.initializing)return;
    this.ownsDraft = true;
    this.suspendDraftOnHide = false;
    // The native album/camera can keep the mini-program hidden for an
    // unbounded amount of time. Measure the callback timeout only while the
    // picker page is foregrounded; otherwise a deliberate slow selection
    // invalidates the eventual success callback and silently drops the photo.
    if (this.pickerInFlight && this.pickerTimeoutPaused) {
      this.pickerTimeoutPaused = false;
      this.armPhotoPickerTimeout();
    }
    // Camera and album temporarily hide the page. On some phones onShow fires
    // before the picker success callback. Restoring the old snapshot here used
    // to erase the freshly selected photo as soon as the user returned.
    if (!this.pickerInFlight) this.restoreDraft();
    if(readDraft(this.data.sessionKey).submission?.requestId){
      wx.redirectTo({url:"/pages/inspection/result/index?sessionKey="+encodeURIComponent(this.data.sessionKey)});return;
    }
    const retryDraft=readDraft(this.data.sessionKey);
    if(retryDraft.retryRequested){
      try{patchDraft(this.data.sessionKey,{retryRequested:false});}
      catch(error){wx.showModal({title:"重新识图未启动",content:error.message||"照片仍已保留，请点下一步重新整理。",showCancel:false});return;}
      const retrySessionKey=this.data.sessionKey;
      setTimeout(()=>{if(this.data.sessionKey===retrySessionKey&&this.ownsDraft!==false)this.handleAnalyze();},0);
      return;
    }
    // Every edit is already persisted. Do not install a native Back guard:
    // some clients keep it alive after this page is hidden, so it can block
    // the next page's Back action with an unrelated confirmation.
    if (this.data.analyzing && this.data.analyzeTaskId) {
      this.waitingForAnalysis=true;
      this.pendingInputVersion=readDraft(this.data.sessionKey).inputVersion;
      this.startAnalyzeTaskAdvancement();
      this.scheduleAnalyzeTaskPolling();
    }
  },
  onHide() {
    this.waitingForAnalysis = false;
    this.recordPressActive = false;
    this.recordGesture = (this.recordGesture || 0) + 1;
    if(this.data.transcribingIssueId)this.handleRecordCancel();
    this.persistDraft();
    if (this.pickerInFlight && this.pickerTimer) {
      clearTimeout(this.pickerTimer);
      this.pickerTimer = null;
      this.pickerTimeoutPaused = true;
    }
    // Only an internal editor/review page is allowed to take over this draft.
    // System camera/album and app backgrounding must keep capture ownership.
    if (this.suspendDraftOnHide) this.ownsDraft = false;
    this.clearAnalyzeTaskPolling();
    // The native unload guard survives navigation in Developer Tools. Do not
    // let the hidden capture page intercept annotation/review navigation.
    if (typeof wx.disableAlertBeforeUnload === "function") {
      wx.disableAlertBeforeUnload();
    }
  },
  onUnload() {
    this.recordPressActive=false;
    this.recordGesture=(this.recordGesture||0)+1;
    this.pickerEpoch = (this.pickerEpoch || 0) + 1;
    clearTimeout(this.pickerTimer);
    this.pickerTimer = null;
    this.pickerTimeoutPaused = false;
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
    if(this.boundRecorderStart&&typeof recorderManager.offStart==='function')recorderManager.offStart(this.boundRecorderStart);
    this.boundRecorderStart=null;
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
      recordingIssueId: "",
      transcribingIssueId: "",
      transcribeStartedAt: 0,
      analyzing: false,
      analyzeStageText: "",
      analyzeStageIndex: 0,
      analyzeCompletedPhotos: 0,
      analyzeTotalPhotos: 0,
      analyzePhotoProgressText: "",
      analyzeProgressPercent: 0,
      analyzeError: "",
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
      const reviewItems=cached.review?.items || cached.analysis?.items || [];
      const issueDrafts = normalizeIssueDrafts(cachedForm.issueDrafts).map(p=>({...p,aiIssues:p.aiRecognized?reviewItems.filter(i=>i.sourcePhotoId===p.id).map(i=>i.description):[]}));
      const shouldResumeAnalysis = cached.phase === "analyzing" && Boolean(cached.taskId);
      this.setData({
        form: {
          ...this.data.form,
          ...cachedForm,
          issueDrafts
        },
        returnContext: cachedReturnContext || this.data.returnContext || null,
        analyzeTaskId: cached.taskId || "",
        analyzing: shouldResumeAnalysis,
        analyzePanelTitle: getAnalyzePanelTitle(issueDrafts),
        analyzeStageText: shouldResumeAnalysis ? "正在恢复照片分析" : this.data.analyzeStageText,
        analyzeError: "",
        issueDraftCount: issueDrafts.length,
        nextActionLabel: getNextActionLabel(issueDrafts),
        issueExpandedStates: buildIssueExpandedStates(issueDrafts, this.data.issueExpandedStates)
      });
      this.resolveCapturePreviewMedia(issueDrafts, this.data.sessionKey);
      return true;
    }
    return false;
  },
  async resolveCapturePreviewMedia(issueDrafts = [], sessionKey = "") {
    const candidates = issueDrafts
      .map((photo) => getPhotoDisplayPath(photo))
      .filter(isCloudFileId);
    if (!candidates.length) return;

    const generation = (this.capturePreviewGeneration || 0) + 1;
    this.capturePreviewGeneration = generation;
    const result = await resolveCloudFileUrls(candidates);
    if (generation !== this.capturePreviewGeneration || sessionKey !== this.data.sessionKey) return;

    // Only replace the presentation path. Stable cloud IDs and local recovery
    // paths remain untouched for upload, retry and report binding.
    const current = this.data.form.issueDrafts || [];
    const next = current.map((photo) => {
      const stablePath = getPhotoDisplayPath(photo);
      return {
        ...photo,
        displayImagePath: isCloudFileId(stablePath)
          ? (result.urls[stablePath] || stablePath)
          : stablePath
      };
    });
    this.setData({"form.issueDrafts": next, failedPhotoPreviewId: ""});
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
  /**
   * 现场记录页有 4 个引导步骤，依次点亮：
   * 添加照片 → 标注 → 按住说话 → 进入核对。
   * 后三步的目标元素要等到有照片才存在，所以每步都带 ready 判断。
   */
  ...coachMethodsMulti([
    { key: "capturePickPhoto", selector: "#coach-pick-photo" },
    // 后三步要等到有照片才存在。此时不能什么都不显示——那样引导走到一半就断了，
    // 改为居中气泡说明「先做这一步，我带你继续」。
    { key: "captureAnnotate", selector: "#coach-annotate",
      pendingText: "先拍一张照片，拍完我带你圈出问题位置。",
      ready() { return Boolean((this.data.form.issueDrafts || []).length); } },
    { key: "captureVoice", selector: "#coach-voice",
      pendingText: "先拍一张照片，拍完我带你写说明。",
      ready() { return Boolean((this.data.form.issueDrafts || []).length); } },
    { key: "captureContinue", selector: "#coach-continue",
      pendingText: "先拍一张照片并写好说明，再进入核对。",
      ready() { return Boolean((this.data.form.issueDrafts || []).length); } }
  ]),
  chooseImages(event = {}) {
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
    const requestedSourceType = event.currentTarget && event.currentTarget.dataset
      ? event.currentTarget.dataset.sourceType || ""
      : "";
    const epoch = this.pickerEpoch = (this.pickerEpoch || 0) + 1;
    this.activePickerEpoch = epoch;
    const isCurrent = () => page.pickerEpoch === epoch && page.data.sessionKey === sessionKey && page.data.form.projectId === projectId;
    const finish = (error = "") => {
      if (!isCurrent()) return;
      clearTimeout(page.pickerTimer);
      page.pickerTimer = null;
      page.pickerTimeoutPaused = false;
      page.pickerInFlight = false;
      page.setData({pickingImages:false,pickerSourceType:"",pickerStatusText:"",pickerError:error});
    };
    this.pickerInFlight = true;
    this.setData({pickingImages:true,pickerSourceType:requestedSourceType,pickerStatusText:"正在打开…",pickerError:""});
    this.armPhotoPickerTimeout = () => {
      clearTimeout(page.pickerTimer);
      page.pickerTimer = setTimeout(() => {
        finish("选图未返回。可重新打开相册，或先保留草稿返回。");
        if (isCurrent()) page.pickerEpoch += 1;
      }, 120000);
    };
    this.armPhotoPickerTimeout();

    const commitPickedPaths = async (paths) => {
      if (!isCurrent()) return;
      const list = (paths || []).filter(Boolean);
      if (!list.length) {
        finish();
        return;
      }
      page.setData({pickerStatusText:"正在保存…"});
      try { for(let i=0;i<list.length;i++)list[i]=await keepLocalFile(list[i]); }
      catch(e){finish(e.message || "照片未保存，请重试");return;}
      if (!isCurrent()) return;
      const issueDrafts = normalizeIssueDrafts((page.data.form.issueDrafts || []).concat(list.map((p) => createIssueDraft(p))));
      const issueExpandedStates = buildExpandedStatesAfterAppend(page.data.form.issueDrafts.length, list.length);

      page.setData({
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length,
        nextActionLabel: getNextActionLabel(issueDrafts),
        issueExpandedStates,
        failedPhotoPreviewId: ""
      });
      if (!page.persistDraft()) {
        finish("照片已显示，但草稿未保存。请勿关闭页面，释放存储后重试保存。");
        return;
      }
      finish();
      page.setData({photoChoiceIds:[],photoChoiceOpen:false});

      if (issueDrafts.length >= MAX_ISSUE_DRAFTS) {
        wx.showToast({
          title: "已达到20张上限",
          icon: "none"
        });
      } else {
        wx.showToast({title:`已添加${list.length}张照片`,icon:"success"});
      }
      // 照片到手，引导推进到「在照片上圈出问题位置」
      page.advanceCoach("capturePickPhoto");
      page.syncCoach();
    };

    const handlePickerFail = (error, sourceType) => {
      if (!isCurrent()) return;
      finish(isUserCancelledPrivacyOrPicker(error) ? "" : "无法打开相册或相机，请重试或检查授权。");
      if (isPrivacyScopeUndeclared(error)) {
        wx.showModal({
          title: "暂时无法选择照片",
          content: "此功能暂不可用，请稍后重试。你可以先输入文字记录。",
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
      page.setData({pickerSourceType:sourceType,pickerStatusText:sourceType === "camera" ? "正在拍照…" : "正在选择…"});
      choosePhotoFiles({count, sourceType: [sourceType]})
        .then((paths) => {
          if (!paths.length) {
            finish("没有选择到照片，请重新选择。" );
            return;
          }
          commitPickedPaths(paths);
        })
        .catch((error) => handlePickerFail(error, sourceType));
    };

    if (requestedSourceType === "camera" || requestedSourceType === "album") {
      openIssueImagePicker(requestedSourceType);
      return;
    }

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
    if (this.pickerInFlight) return;
    const dataset=event.currentTarget.dataset||{};
    const photos=this.data.form && this.data.form.issueDrafts;
    const index=dataset.id ? (Array.isArray(photos)?photos:[]).findIndex(photo=>photo.id===dataset.id) : Number(dataset.index);
    const issue = Array.isArray(photos) ? photos[index] : null;
    if (!issue) {
      return;
    }
    if(issue.isTranscribing){wx.showToast({title:"语音转写完成后再更换照片",icon:"none"});return;}
    const issueId=issue.id;

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

    let paths;
    this.pickerInFlight = true;
    try {
      paths = await choosePhotoFiles({count: 1, sourceType: ["album", "camera"]});
    } catch (error) {
      this.pickerInFlight = false;
      if (isPrivacyScopeUndeclared(error)) {
        wx.showModal({
          title: "暂时无法选择照片",
          content: "此功能暂不可用，请稍后重试。你可以先输入文字记录。",
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

    this.pickerInFlight = false;
    const tempFilePath = paths && paths[0];
    if (!tempFilePath) {
      return;
    }

    let savedPath;
    try { savedPath=await keepLocalFile(tempFilePath); }
    catch(e){wx.showModal({title:"照片未保存",content:e.message,showCancel:false});return;}
    const currentPhotos=this.data.form && this.data.form.issueDrafts;
    const currentIndex=Array.isArray(currentPhotos) ? currentPhotos.findIndex(photo=>photo.id===issueId) : -1;
    if(currentIndex<0){wx.showToast({title:"照片列表已变化，未替换任何照片",icon:"none"});return;}
    const current=currentPhotos[currentIndex];
    const issueDrafts=currentPhotos.map(photo=>photo.id===issueId?{
      ...photo,imagePath:savedPath,localImagePath:savedPath,displayImagePath:savedPath,
      localAnnotatedImagePath:"",sourceOriginalImagePath:"",localOriginalImagePath:"",
      annotationStage:null,annotationDirty:false,mediaRevision:(current.mediaRevision||1)+1,
      annotatedImagePath:"",annotationRevision:0,annotations:[],annotationCount:0
    }:photo);
    this.setData({form:{...this.data.form,issueDrafts},failedPhotoPreviewId:""});
    this.persistDraft();
    wx.showToast({
      title: "照片已更换",
      icon: "success"
    });
  },
  handlePhotoPreviewError(event) {
    const issueId = `${event.currentTarget.dataset.id || ""}`;
    if (!issueId) return;
    this.setData({failedPhotoPreviewId: issueId});
  },
  handleIssueVoiceTextInput(event) {
    const dataset=event.currentTarget.dataset||{};
    const photos=this.data.form && this.data.form.issueDrafts;
    if(!Array.isArray(photos))return;
    const index=dataset.id ? photos.findIndex(photo=>photo.id===dataset.id) : Number(dataset.index);
    const issue=photos[index];
    if(!issue)return;
    const nextMode = issue.analysisMode === "ai" ? "ai" : "manual";
    const issueDrafts=photos.map((photo,photoIndex)=>photoIndex===index?{...photo,voiceText:event.detail.value||"",analysisMode:nextMode,analysisModeResolved:nextMode}:photo);
    this.setData({form:{...this.data.form,issueDrafts},nextActionLabel:getNextActionLabel(issueDrafts)});
    this.persistDraft();
  },
  handleAnalysisModeChange(event) {
    const dataset=event.currentTarget.dataset||{},mode=dataset.mode;
    const photos=this.data.form && this.data.form.issueDrafts;
    if(!Array.isArray(photos))return;
    const index=dataset.id ? photos.findIndex(photo=>photo.id===dataset.id) : Number(dataset.index);
    const issue=photos[index];
    if(!issue||!["manual","ai"].includes(mode))return;
    const issueDrafts=photos.map((photo,photoIndex)=>photoIndex===index?{...photo,analysisMode:mode,analysisModeResolved:mode}:photo);
    this.setData({form:{...this.data.form,issueDrafts},nextActionLabel:getNextActionLabel(issueDrafts)});
    this.persistDraft();
  },
  recognizePhoto(event) {
    const id=event.currentTarget.dataset.id;
    return this.startPhotoRecognition([id]);
  },
  async startPhotoRecognition(ids) {
    if(this.data.analyzing || this.data.pickingImages)return;
    if(this.data.transcribingIssueId || this.data.form.issueDrafts.some(p=>p.isTranscribing)){
      wx.showToast({title:'请等语音转写完成',icon:'none'});return;
    }
    const selected=new Set(ids);
    const before=readDraft(this.data.sessionKey);
    if(before.submission?.requestId){wx.showToast({title:'记录已提交，不能重新识图',icon:'none'});return;}
    const photos=this.data.form.issueDrafts.map(p=>({...p,analysisMode:selected.has(p.id)?'ai':'manual',organizeText:false}));
    if(!photos.some(p=>selected.has(p.id)))return;
    const priorItems=before.review?.items || before.analysis?.items || buildManualReviewItems(photos);
    const originalItems=before.review?.originalItems || before.analysis?.items || [];
    this.setData({form:{...this.data.form,issueDrafts:normalizeIssueDrafts(photos)},nextActionLabel:getNextActionLabel(photos)});
    if(!this.persistDraft())return;
    try{
      patchDraft(this.data.sessionKey,{taskId:'',analysisRequestId:'',analysisReturn:'capture',recognitionPhotoIds:[...selected],review:{...before.review,items:priorItems,originalItems,stale:true,stalePhotoIds:[...selected]}});
    }catch(error){this.setData({analyzeError:error.message||'草稿保存失败'});return;}
    this.setData({analyzeTaskId:''});
    return this.handleAnalyze();
  },
  chooseSinglePhotoProcessing(event) {
    const dataset = event.currentTarget.dataset || {};
    const photos = this.data.form && this.data.form.issueDrafts;
    const index = dataset.id && Array.isArray(photos)
      ? photos.findIndex(photo => photo.id === dataset.id)
      : Number(dataset.index);
    if (!Array.isArray(photos) || !photos[index]) return;
    this.setData({photoChoiceIds:[photos[index].id],photoChoiceOpen:true});
  },
  choosePhotoProcessing(event) {
    const mode=event.currentTarget.dataset.mode;
    if(!['manual','ai'].includes(mode))return;
    const selected=new Set(this.data.photoChoiceIds);
    const photos=normalizeIssueDrafts(this.data.form.issueDrafts.map(photo=>selected.has(photo.id)?{...photo,analysisMode:mode}:photo));
    const first=photos.findIndex(photo=>selected.has(photo.id));
    this.setData({form:{...this.data.form,issueDrafts:photos},nextActionLabel:getNextActionLabel(photos),photoChoiceOpen:false,photoChoiceIds:[],issueExpandedStates:photos.map((_,index)=>index===first)});
    this.persistDraft();
    if(mode==='ai')return this.startPhotoRecognition([...selected]);
  },
  ignoreTap() {},
  deferPhotoProcessing() {
    // Keeping a photo without a problem is an explicit manual path.
    this.choosePhotoProcessing({currentTarget:{dataset:{mode:'manual'}}});
  },
  chooseAllPhotoProcessing() {
    this.setData({photoChoiceIds:this.data.form.issueDrafts.map(photo=>photo.id),photoChoiceOpen:true});
  },
  handlePhotoMenu(event) {
    const index=Number(event.currentTarget.dataset.index);
    const photo=this.data.form.issueDrafts[index];
    if(!photo||photo.isTranscribing||this.data.analyzing||this.data.transcribingIssueId)return;
    const actions=[{label:'更换照片',run:()=>this.replaceIssueImage(event)}];
    if(index>0)actions.push({label:'上移',run:()=>this.moveIssue({currentTarget:{dataset:{index,step:-1}}})});
    if(index<this.data.form.issueDrafts.length-1)actions.push({label:'下移',run:()=>this.moveIssue({currentTarget:{dataset:{index,step:1}}})});
    actions.push({label:'删除照片',run:()=>this.removeIssue(event)});
    wx.showActionSheet({itemList:actions.map(action=>action.label),success:result=>actions[result.tapIndex]?.run()});
  },
  async handleContinueReview() {
    this.advanceCoach("captureContinue");
    if(this.data.transcribingIssueId||this.data.form.issueDrafts.some(photo=>photo.isTranscribing)){
      wx.showToast({title:'请等语音转写完成',icon:'none'});return;
    }
    const current=readDraft(this.data.sessionKey);
    if(current.review && !current.review.stale)return this.handleManualReview();
    // Explicitly opt new clients into text organization. Older drafts/clients
    // keep the old manual fallback until this ordinary Next action is used.
    const photos = normalizeIssueDrafts(this.data.form.issueDrafts.map(photo => ({...photo,analysisMode:'manual', organizeText:hasMeaningfulVoiceText(photo.voiceText)})));
    this.setData({form:{...this.data.form,issueDrafts:photos},nextActionLabel:getNextActionLabel(photos)});
    if (!this.persistDraft()) return;
    return countTextOrganizationDrafts(photos)>0?this.handleAnalyze():this.handleManualReview();
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
  handleRecordTouchStart(event) {
    this.advanceCoach("captureVoice");
    this.recordPressActive=true;
    this.recordGesture=(this.recordGesture||0)+1;
    this.recordStartY=event.touches?.[0]?.clientY||0;
    this.setData({recordCancelArmed:false});
    if(event.currentTarget?.dataset?.index!==undefined)return this.handleRecordLongPress(event);
  },
  async handleRecordLongPress(event) {
    const index = Number(event.currentTarget.dataset.index);
    const issue = this.data.form.issueDrafts[index];

    if (!issue || issue.isTranscribing || this.data.transcribingIssueId) {
      return;
    }

    const gesture=this.recordGesture;
    try {
      if(!this.recordPermissionReady && typeof wx.getSetting==='function'){
        const setting=await new Promise((resolve,reject)=>wx.getSetting({success:resolve,fail:reject}));
        if(!setting.authSetting?.['scope.record'])await new Promise((resolve,reject)=>wx.authorize({scope:'scope.record',success:resolve,fail:reject}));
        this.recordPermissionReady=true;
      }
    }catch(error){this.boundRecorderError?.(error);return;}
    // Authorization can outlive the finger gesture. A fresh press is required
    // after release; never start an unattended recording behind a permission UI.
    if(!this.recordPressActive||gesture!==this.recordGesture)return;
    this.recordCancelled=false;
    this.setData({
      recordCancelArmed:false,
      transcribingIssueId: issue.id,
      transcribeStartedAt: Date.now()
    });
    recorderManager.start({
      format: "mp3",
      duration: 60000,
      sampleRate:16000,
      numberOfChannels:1,
      encodeBitRate:48000
    });
  },
  handleRecordTouchEnd() {
    this.recordPressActive=false;
    if (!this.data.transcribingIssueId) {
      return;
    }

    this.recordCancelled=!!this.data.recordCancelArmed;
    if(this.recorderStarted)recorderManager.stop();
  },
  handleRecordMove(event){
    if(!this.data.transcribingIssueId || !event.touches?.[0])return;
    this.setData({recordCancelArmed:this.recordStartY-event.touches[0].clientY>60});
  },
  handleRecordCancel(){this.recordPressActive=false;this.recordGesture=(this.recordGesture||0)+1;this.recordCancelled=true;recorderManager.stop();},
  async handleIssueTranscription(issueId, tempFilePath, duration, fileID = "") {
    try {
      const result = await transcribeVoiceFile(tempFilePath, {
        duration,
        label: "inspection",
        fileID
      });
      const issueDrafts = this.data.form.issueDrafts.map((item) => {
        if (item.id !== issueId) {
          return item;
        }

        return {
          ...item,
          isTranscribing: false,
          voiceFilePath: tempFilePath,
          voiceDuration: duration,
          voiceStorageFileId: result.fileID || "",
          voiceFileId: result.fileID || "",
          speechError:"",
          voiceText: mergeSpeechText(item.voiceText, result.text, true),
          analysisMode: item.analysisMode === "ai" ? "ai" : "manual",
          analysisModeResolved: item.analysisMode === "ai" ? "ai" : "manual"
        };
      });

      this.setData({
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length,
        nextActionLabel: getNextActionLabel(issueDrafts)
      });
      this.persistDraft();
      wx.showToast({
        title: "转写完成",
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
          voiceDuration: duration,
          voiceStorageFileId: error.fileID || item.voiceStorageFileId || "",
          voiceFileId: error.fileID || item.voiceFileId || "",
          speechError: `${formatSpeechError(error).message}。录音已保留，可重试或直接输入。`
        };
      });
      this.setData({
        "form.issueDrafts": issueDrafts,
        issueDraftCount: issueDrafts.length,
        nextActionLabel: getNextActionLabel(issueDrafts)
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
  retryIssueTranscription(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.form.issueDrafts[index];
    if (!item || !item.voiceFilePath || item.isTranscribing || this.data.transcribingIssueId) return;
    const issueDrafts = this.data.form.issueDrafts.map((draft, draftIndex) => draftIndex === index
      ? { ...draft, isTranscribing: true, speechError: "" }
      : draft);
    this.setData({ "form.issueDrafts": issueDrafts, issueDraftCount: issueDrafts.length });
    this.persistDraft();
    return this.handleIssueTranscription(item.id, item.voiceFilePath, item.voiceDuration || 0, item.voiceStorageFileId || item.voiceFileId || "");
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
      nextActionLabel: getNextActionLabel(issueDrafts),
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

    // 用户已经找到「标注」了，引导推进到「写说明或按住说话」
    this.advanceCoach("captureAnnotate");
    this.persistDraft();
    this.suspendDraftOnHide = true;
    wx.navigateTo({
      url: `/pages/inspection/annotate/index?sessionKey=${this.data.sessionKey}&issueId=${encodeURIComponent(issue.id)}`
    });
  },
  async uploadAssets() {
    const form = await uploadDraftMedia(this.data.form, async (form, progress) => {
      this.setData({form});
      if (!this.persistDraft()) throw new Error("草稿保存失败");
      this.setData({
        analyzeProgressLabel: "已上传",
        analyzeCompletedPhotos: progress.completedFiles,
        analyzeTotalPhotos: progress.totalFiles,
        analyzeProgressPercent: progress.percent,
        analyzeStageText: `正在保存照片与标注（${progress.completedFiles}/${progress.totalFiles} 项）`
      });
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
    if(cached.review && !cached.review.stale) {
      this.suspendDraftOnHide = true;
      wx.navigateTo({url:"/pages/inspection/result/index?sessionKey="+encodeURIComponent(this.data.sessionKey)});return;
    }
    const photoIds=new Set(this.data.form.issueDrafts.map(p=>p.id));
    const kept=(cached.review?.items || cached.analysis?.items || []).filter(i=>photoIds.has(i.sourcePhotoId));
    const existingSources=new Set(kept.map(i=>i.sourcePhotoId));
    const items=kept.concat(buildManualReviewItems(this.data.form.issueDrafts).filter(i=>!existingSources.has(i.sourcePhotoId)));
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
      const completed = Number(this.data.analyzeCompletedPhotos) || 0;
      const total = Number(this.data.analyzeTotalPhotos) || 0;
      this.setData({
        analyzing: false,
        analyzeStageIndex: 0,
        analyzeStageText: total ? `已完成 ${completed}/${total} 张，进度已保存` : "分析进度已保存",
        analyzeTaskId: this.data.analyzeTaskId || "",
        analyzeError: "网络不稳定，暂时无法取得分析结果。可重试未完成照片，也可直接人工核对。"
      });
      // Keep the recovery panel visible. The actual page action is「下一步·核对内容」;
      // there is no「分析整理」button, so a modal naming that nonexistent control
      // leaves the user guessing and can trigger repeated taps.
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
      analyzeError: "",
      analyzeTaskId: this.data.analyzeTaskId || ""
    });
    wx.showToast({
      title: "已停止等待，草稿已保留",
      icon: "none"
    });
  },

  async completeAnalyzeSuccess(form, analysis) {
    const sessionKey=this.data.sessionKey;
    const isManual=analysis && analysis.aiMode==="manual";
    // A request can finish after the capture page has yielded the session to
    // annotation/review, or after a successful submission removed the draft.
    // Such a late response must never resurrect or overwrite that session.
    if(!sessionKey||this.ownsDraft===false||(!isManual&&!this.waitingForAnalysis))return false;
    if(wx.getStorageSync(sessionKey+":complete")){
      this.waitingForAnalysis=false;
      this.clearAnalyzeTaskPolling();
      return false;
    }
    // Read/check the current version BEFORE touching form or persisting the
    // request's snapshot; otherwise a late result itself overwrites new input.
    let draft = readDraft(sessionKey);
    if(!draft.form){
      this.waitingForAnalysis=false;
      this.clearAnalyzeTaskPolling();
      this.setData({analyzing:false,analyzeStageIndex:0,analyzeTaskId:"",analyzeError:"本次草稿已结束或无法读取，分析结果没有写入。"});
      wx.showModal({title:"记录暂时无法继续",content:"分析已返回，但本次草稿不存在，结果没有写入其他记录。请返回项目重新打开原记录。",showCancel:false});
      return false;
    }
    if(!isManual&&this.pendingInputVersion&&draft.inputVersion!==this.pendingInputVersion){
      this.waitingForAnalysis=false;
      this.clearAnalyzeTaskPolling();
      this.setData({analyzing:false,analyzeStageIndex:0,analyzeError:"照片或说明已变化，请重新分析当前记录。"});
      wx.showModal({title:"记录内容已变化",content:"分析期间照片或说明有更新，旧结果没有写入。请确认当前照片后重新分析。",showCancel:false});
      return false;
    }
    const returnToCapture=draft.analysisReturn==='capture' && !isManual;
    if(returnToCapture){
      const recognized=new Set(draft.recognitionPhotoIds||[]);
      form={...form,issueDrafts:normalizeIssueDrafts(form.issueDrafts.map(p=>({...p,analysisMode:'manual',organizeText:false,aiRecognized:recognized.has(p.id)||p.aiRecognized})))};
    }
    this.setData({form});
    if (!this.persistDraft()) return false;
    draft = readDraft(sessionKey);
    const refreshedReview = mergeReanalyzedReview(draft, analysis, form);
    const mergedObservations=mergeReanalyzedObservations(draft,analysis,form);
    // Re-check ownership immediately before mutating the shared draft. This
    // protects against navigation/submission state changes during async work.
    if(this.ownsDraft===false||wx.getStorageSync(sessionKey+":complete"))return false;
    try{
      patchDraft(sessionKey,{
        phase:"review",
        analysis:{...analysis,items:refreshedReview?.originalItems || analysis.items,observations:mergedObservations},
        analysisReturn:'',recognitionPhotoIds:[],
        ...(refreshedReview ? {review:refreshedReview} : {})
      });
    }catch(error){
      this.waitingForAnalysis=false;
      this.clearAnalyzeTaskPolling();
      this.setData({analyzing:false,analyzeStageIndex:0,analyzeError:error.message||"草稿保存失败"});
      wx.showModal({title:"分析结果未保存",content:(error.message||"草稿保存失败")+"。已保留当前照片，请重新打开记录核对。",showCancel:false});
      return false;
    }
    this.clearAnalyzeTaskPolling();
    this.waitingForAnalysis=false;
    this.setData({
      analyzing:false,
      analyzeStageIndex:0,
      analyzeStageText:"",
      analyzeError:"",
      analyzeProgressPercent:100
    });
    if(returnToCapture){
      const reviewItems=refreshedReview?.items || analysis.items || [];
      this.setData({form:{...form,issueDrafts:form.issueDrafts.map(p=>({...p,aiIssues:reviewItems.filter(i=>i.sourcePhotoId===p.id).map(i=>i.description)}))},nextActionLabel:getNextActionLabel(form.issueDrafts)});
      wx.showToast({title:'识图完成，请核对问题',icon:'none'});
      return true;
    }
    this.suspendDraftOnHide = true;
    wx.navigateTo({url:"/pages/inspection/result/index?sessionKey="+encodeURIComponent(sessionKey)});
    return true;
  },
  async pollAnalyzeTaskStatus() {
    if (!this.data.analyzeTaskId) {
      this.clearAnalyzeTaskPolling();
      return "idle";
    }
    const taskId=this.data.analyzeTaskId;
    const result = await readInspectionTaskStatus(taskId);
    if(this.data.analyzeTaskId!==taskId)return 'stale';
    if(!this.waitingForAnalysis)return "paused";
    if(this.pendingInputVersion!==readDraft(this.data.sessionKey).inputVersion){this.setData({analyzing:false});return "stale";}
    // 成功拿到一次状态就清零失败计数，避免历史上抖动的次数累积
    this.analyzePollFailureCount = 0;
    const totalPhotos = result.totalPhotos || result.totalBatches || 0;
    const completedPhotos = result.completedPhotos || result.completedBatches || 0;
    const progressKey = `${this.data.analyzeTaskId}:${completedPhotos}`;
    if (this.analyzeProgressKey !== progressKey) {
      this.analyzeProgressKey = progressKey;
      this.analyzeProgressAt = Date.now();
    }
    if (!['success', 'failed'].includes(result.status) &&
        (result.status === 'cancelled' || Date.now() - this.analyzeProgressAt >= ANALYZE_NO_PROGRESS_LIMIT)) {
      this.stopAnalyzeWaiting(result.status === 'cancelled'
        ? '分析已停止，照片已保留，可重新选择 AI 识别或人工核对。'
        : '分析长时间没有进展，已停止等待。照片和进度已保留，可重试或人工核对。');
      return result.status === 'cancelled' ? 'cancelled' : 'stalled';
    }
    const progressPercent = totalPhotos
      ? Math.min(100, Math.round((completedPhotos / totalPhotos) * 100))
      : 0;
    const completedPhotoNumbers = this.formatAnalyzePhotoNumbers(result.completedPhotoIndexes);
    const pendingPhotoNumbers = this.formatAnalyzePhotoNumbers(result.pendingPhotoIndexes);
    const photoProgressText = result.status === "failed"
      ? (pendingPhotoNumbers ? `待重试照片：${pendingPhotoNumbers}` : "")
      : (completedPhotoNumbers ? `已完成照片：${completedPhotoNumbers}` : "");
    if (result.status === "success" && result.analysis) {
      this.setData({
        analyzeStageIndex: 3,
        analyzeStageText: "正在整理问题清单"
      });
      await this.completeAnalyzeSuccess(this.pendingAnalyzeForm || this.data.form, result.analysis);
      return "success";
    }
    if (result.status === "failed") {
      // A retry call changes failed -> running. A read arriving in that small
      // window must not immediately close the progress panel again.
      if (this.analyzeAdvanceInFlight) {
        this.setData({
          analyzeProgressLabel: "进度",
          analyzing: true,
          analyzeStageText: `正在重试未完成照片（${completedPhotos}/${totalPhotos}）`,
          analyzeCompletedPhotos: completedPhotos,
          analyzeTotalPhotos: totalPhotos,
          analyzeProgressPercent: progressPercent,
          analyzePhotoProgressText: photoProgressText
        });
        this.scheduleAnalyzeTaskPolling();
        return "running";
      }
      this.clearAnalyzeTaskPolling();
      this.setData({
        analyzeProgressLabel: "进度",
        analyzing: false,
        analyzeStageIndex: 0,
        analyzeStageText: `已完成 ${completedPhotos}/${totalPhotos} 张`,
        analyzeCompletedPhotos: completedPhotos,
        analyzeTotalPhotos: totalPhotos,
        analyzeProgressPercent: progressPercent,
        analyzePhotoProgressText: photoProgressText,
        analyzeError: result.errorMessage || "有照片尚未完成分析",
        analyzeTaskId: this.data.analyzeTaskId || ""
      });
      return "failed";
    }
    this.setData({
      analyzeProgressLabel: "进度",
      analyzeStageIndex: 2,
      analyzeStageText: totalPhotos
        ? `正在逐张分析（${Math.min(completedPhotos, totalPhotos)}/${totalPhotos} 张）`
        : "正在准备照片分析",
      analyzeCompletedPhotos: completedPhotos,
      analyzeTotalPhotos: totalPhotos,
      analyzeProgressPercent: progressPercent,
      analyzePhotoProgressText: photoProgressText,
      analyzeError: ""
    });
    this.startAnalyzeTaskAdvancement();
    this.scheduleAnalyzeTaskPolling();
    return result.status || "running";
  },
  formatAnalyzePhotoNumbers(indexes) {
    if (!Array.isArray(indexes)) return "";
    return [...new Set(indexes.map(Number).filter(index => Number.isInteger(index) && index >= 0))]
      .sort((a,b)=>a-b)
      .map(index=>String(index+1).padStart(2,"0"))
      .join("、");
  },
  startAnalyzeTaskAdvancement() {
    if (!this.data.analyzeTaskId || this.analyzeAdvanceInFlight) return;
    const taskId = this.data.analyzeTaskId;
    this.analyzeAdvanceInFlight = true;
    advanceInspectionTask(taskId)
      .catch((error) => {
        console.error("[inspection-create] advanceAnalyzeTask failed", error);
        if (this.waitingForAnalysis && this.data.analyzeTaskId === taskId) this.stopAnalyzeWaiting(error.message || 'AI 分析未能启动，请重试或人工核对。');
      })
      .finally(() => {
        this.analyzeAdvanceInFlight = false;
        if (!this.waitingForAnalysis) return;
        // Keep a fixed read cadence. If another client still holds the lease,
        // an immediate advance can return quickly; recursively polling here
        // would otherwise create a hot loop.
        this.scheduleAnalyzeTaskPolling();
      });
  },
  stopAnalyzeWaiting(message) {
    this.waitingForAnalysis = false;
    this.clearAnalyzeTaskPolling();
    this.setData({analyzing:false, analyzeStageIndex:0, analyzeError:message});
  },
  handleRetryAnalyze() {
    if (this.data.analyzing) return;
    if (!this.data.analyzeTaskId) {this.setData({analyzeError:''});return this.handleAnalyze();}
    this.waitingForAnalysis = true;
    this.analyzeProgressKey = '';
    this.analyzeProgressAt = Date.now();
    this.pendingInputVersion = readDraft(this.data.sessionKey).inputVersion;
    this.setData({
      analyzing: true,
      analyzeError: "",
      analyzeStageIndex: 2,
      analyzeStageText: `正在重试未完成照片（${this.data.analyzeCompletedPhotos}/${this.data.analyzeTotalPhotos}）`
    });
    this.startAnalyzeTaskAdvancement();
    this.scheduleAnalyzeTaskPolling();
  },
  async handleAnalyzeManualFallback() {
    this.waitingForAnalysis = false;
    this.clearAnalyzeTaskPolling();
    this.setData({analyzing:false, analyzeError:""});
    let stopped = false;
    if (this.data.analyzeTaskId) {
      try {
        const task = await cancelInspectionTask(this.data.analyzeTaskId);
        stopped = task.status === "cancelled" || ["success", "failed"].includes(task.status);
      } catch (error) {
        console.warn("[inspection-create] cancelAnalyzeTask failed", error);
      }
    }
    if (!stopped && this.data.analyzeTaskId) {
      wx.showToast({title:"已转人工核对；云端当前请求可能仍在结束",icon:"none",duration:2500});
    }
    this.handleManualReview();
  },
  async handleAnalyze() {
    if(this.data.analyzing)return;
    const stored=readDraft(this.data.sessionKey);
    if(stored.review && !stored.review.stale){this.handleManualReview();return;}
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

    if (countImageRecognitionDrafts(this.data.form.issueDrafts) + countTextOrganizationDrafts(this.data.form.issueDrafts) === 0) {
      // Every photo already has an inspector-authored statement. The user has
      // explicitly chosen the manual path, so entering review must be instant
      // and must not spend vision quota on a second opinion they did not ask for.
      await this.handleManualReview();
      return;
    }

    this.waitingForAnalysis=true;
    this.pendingInputVersion=stored.inputVersion;
    const analyzePanelTitle = getAnalyzePanelTitle(this.data.form.issueDrafts);
    this.setData({
      analyzing: true,
      analyzePanelTitle,
      analyzeStageIndex: 1,
      analyzeStageText: "正在上传并校验照片",
      analyzeProgressLabel: "已上传",
      analyzeCompletedPhotos: 0,
      analyzeTotalPhotos: 0,
      analyzeProgressPercent: 0,
      analyzePhotoProgressText: "",
      analyzeError: ""
    });
    let keepAnalyzing = false;

    try {
      const form = await this.uploadAssets();
      const saved = readDraft(this.data.sessionKey);
      if(saved.taskId){
        this.setData({analyzeTaskId:saved.taskId});
        this.pendingAnalyzeForm=form;
        this.startAnalyzeTaskAdvancement();
        this.scheduleAnalyzeTaskPolling();
        keepAnalyzing=true;
        return;
      }
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
          analyzeProgressLabel: "进度",
          analyzeTotalPhotos: task.totalPhotos ?? (countImageRecognitionDrafts(form.issueDrafts) + countTextOrganizationDrafts(form.issueDrafts)),
          analyzeCompletedPhotos: task.completedPhotos || task.completedBatches || 0,
          analyzeProgressPercent: 0,
        analyzeStageText: `正在整理已选择的记录（0/${task.totalPhotos ?? (countImageRecognitionDrafts(form.issueDrafts) + countTextOrganizationDrafts(form.issueDrafts))} 张）`
        });
        this.startAnalyzeTaskAdvancement();
        this.scheduleAnalyzeTaskPolling();
        keepAnalyzing = true;
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
      this.waitingForAnalysis=false;
      this.setData({analyzeError:(error&&error.message)||'整理未完成，照片与原文已保留'});
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
