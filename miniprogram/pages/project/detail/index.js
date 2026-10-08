const { getProjectDetail, getProjectGallery } = require("../../../services/project");
const { formatDateTime, mapProjectStatusText, usesEditorialTypeface } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");
const { listDrafts, writeDraft, readDraft, discardDraft } = require("../../../utils/inspection-draft");
const { cancelInspectionTask } = require("../../../services/inspection");
const { keepLocalFile } = require("../../../services/inspection-media");
const { identity } = require("../../../utils/inspection-model");

function choosePhotoFiles(sourceType) {
  let platform = "";
  try { platform = String((wx.getAppBaseInfo && wx.getAppBaseInfo().platform) || "").toLowerCase(); } catch (_error) {}
  const useLegacy = platform === "devtools" && typeof wx.chooseImage === "function";
  const api = useLegacy ? "chooseImage" : typeof wx.chooseMedia === "function" ? "chooseMedia" : "chooseImage";
  if (typeof wx[api] !== "function") return Promise.reject(new Error("当前微信版本不支持选图，请升级后重试。"));
  return new Promise((resolve, reject) => wx[api]({
    count: sourceType === "camera" ? 1 : 9,
    ...(api === "chooseMedia" ? {mediaType:["image"]} : {sizeType:["original"]}),
    sourceType:[sourceType],
    success(result = {}) {
      const paths = Array.isArray(result.tempFilePaths) ? result.tempFilePaths : [];
      const files = Array.isArray(result.tempFiles) ? result.tempFiles.map(file => file && (file.tempFilePath || file.path)).filter(Boolean) : [];
      resolve(Array.from(new Set(paths.concat(files).filter(Boolean))));
    },
    fail:reject
  }));
}

Page({
  data: {
    loading:true,loadError:"",
    projectId: "",drafts:[],
    project: {},
    recentInspectionExpanded: false,
    recentReportExpanded: false,
    featurePhotoCount: 0,
    captureChoiceOpen: false,
    projectTitleClass: "project-hero__title--ui",
  },
  async onLoad(query) {
    this.setData({
      projectId: query.projectId || ""
    });
  },
  onShow() {
    if (this.data.projectId) {
      this.loadDetail();
    } else {
      this.setData({loading:false,loadError:"缺少项目编号，请返回项目列表重新进入"});
    }
  },
  async loadDetail() {
    const generation = (this.detailLoadGeneration || 0) + 1;
    this.detailLoadGeneration = generation;
    this.setData({loading:true,loadError:""});
    try {
      const [result, galleryResult] = await Promise.all([
        getProjectDetail(this.data.projectId),
        getProjectGallery(this.data.projectId).catch(() => null)
      ]);
      if(!result.project || result.project._id !== this.data.projectId)throw new Error("项目不存在或无权限，请返回重试");
      const drafts = listDrafts(this.data.projectId).map(d=>({...d,timeText:formatDateTime(d.updatedAt)}));
      const inspections = (result.inspections || []).filter(item => !item.deleted);
      const reports = (result.reports || []).filter(item => !item.deleted);
      const galleryPhotos = galleryResult && Array.isArray(galleryResult.photos) ? galleryResult.photos : [];
      if (generation !== this.detailLoadGeneration) return;
      this.setData({
        drafts,
        projectTitleClass: usesEditorialTypeface(result.project && result.project.name) ? "" : "project-hero__title--ui",
        project: {
          ...(result.project || {}),
          clientNameText: (result.project && result.project.clientName) || "未填写",
          clientPhoneText: (result.project && result.project.clientPhone) || "",
          descriptionText: (result.project && result.project.description) || "暂无项目说明",
          statusText: mapProjectStatusText(result.project && result.project.status)
        },
        featurePhotoCount: galleryPhotos.length,
      });
    } catch (error) {
      if (generation !== this.detailLoadGeneration) return;
      this.setData({loadError:error.message||"项目加载失败"});
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    } finally{if (generation === this.detailLoadGeneration) this.setData({loading:false});}
  },
  goEdit() {
    wx.navigateTo({
      url: `/pages/project/form/index?projectId=${this.data.projectId}`
    });
  },
  goInspectionCreate() {
    if (this.data.loading || this.data.loadError) return;
    this.setData({captureChoiceOpen:true});
  },
  closeCaptureChoice() { this.setData({captureChoiceOpen:false}); },
  ignoreTap() {},
  async chooseCaptureSource(event) {
    if (this.data.loading || this.data.loadError || this.captureInFlight) return;
    const sourceType = event.currentTarget.dataset.sourceType;
    if (sourceType !== "camera" && sourceType !== "album") return;
    const projectId = this.data.projectId;
    const project = this.data.project || {};
    if (!projectId || !project._id || project._id !== projectId) {
      wx.showToast({title:"项目状态已变化，请刷新后重试",icon:"none"});
      return;
    }
    this.captureInFlight = true;
    this.captureProjectId = projectId;
    this.setData({captureChoiceOpen:false,capturePicking:true});
    try {
      const paths = await choosePhotoFiles(sourceType);
      if (this.captureProjectId !== projectId || this.data.projectId !== projectId) throw new Error("项目已变化，照片未加入记录，请重新选择");
      if (!paths.length) return;
      const durablePaths = [];
      for (const path of paths) durablePaths.push(await keepLocalFile(path));
      const sessionKey = identity("inspection-create");
      const returnContext = encodeReturnContext({projectId,projectName:project.name || "",returnTarget:"projectDetail"});
      const form = {
        projectId,
        projectName:project.name || "",
        title:"",
        note:"",
        issueDrafts:durablePaths.map(imagePath => ({
          id:identity("photo"),imagePath,localImagePath:imagePath,annotations:[],annotationCount:0,
          annotationRevision:0,analysisMode:"pending",voiceText:"",voiceFilePath:"",voiceFileId:""
        }))
      };
      writeDraft(sessionKey,form,returnContext);
      this.navigateToRecord(sessionKey);
    } catch (error) {
      const message = `${error && (error.errMsg || error.message) || ""}`;
      if (/cancel/i.test(message)) return;
      if (/auth deny|authorize|permission|denied|reject|拒绝|未授权/i.test(message)) {
        wx.showModal({title:sourceType === "camera" ? "无法使用相机" : "无法访问相册",content:"请在微信设置中允许使用后重试；当前仍停留在项目页。",confirmText:"去设置",cancelText:"稍后",success:result=>{if(result.confirm&&wx.openSetting)wx.openSetting({});}});
      } else {
        wx.showToast({title:error.message || "照片未能保存，请重试",icon:"none",duration:3000});
      }
    } finally {
      this.captureInFlight = false;
      this.captureProjectId = "";
      this.setData({capturePicking:false});
    }
  },
  navigateToRecord(sessionKey) {
    if (!sessionKey) return;
    const returnContext = encodeReturnContext({
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      returnTarget: "projectDetail"
    });
    wx.navigateTo({
      url: "/pages/inspection/create/index?projectId=" + encodeURIComponent(this.data.projectId)
        + "&returnContext=" + returnContext
        + (sessionKey ? "&sessionKey=" + encodeURIComponent(sessionKey) : "")
    });
  },
  continueDraft(e){
    if(this.data.loading||this.data.loadError)return;
    const draft=this.data.drafts.find(d=>d.sessionKey===e.currentTarget.dataset.session);
    if(!draft)return;
    this.navigateToRecord(draft.sessionKey);
  },
  deleteDraft(e) {
    const sessionKey=e.currentTarget.dataset.session;
    if(this.deletingDraft || !this.data.drafts.some(d=>d.sessionKey===sessionKey))return;
    wx.showModal({title:'删除未完成记录？',content:'本条记录的照片、标注和未提交内容将移除，无法恢复。不会删除项目或已生成报告。',confirmText:'删除',confirmColor:'#b33d25',success:async result=>{
      if(!result.confirm || this.deletingDraft)return;
      this.deletingDraft=true;
      try{
        const draft=readDraft(sessionKey);
        if(!draft.form || draft.form.projectId!==this.data.projectId)throw new Error('记录已变化，请刷新后重试');
        if(draft.submission?.requestId)throw new Error('这条记录已发起提交，请先继续完成报告，避免误删已保存内容');
        if(draft.taskId){
          const task=await cancelInspectionTask(draft.taskId);
          if(!['cancelled','failed','success'].includes(task.status))throw new Error('分析尚未停止，请稍后重试删除');
        }
        discardDraft(sessionKey,this.data.projectId);
        this.setData({drafts:listDrafts(this.data.projectId).map(d=>({...d,timeText:formatDateTime(d.updatedAt)}))});
        wx.showToast({title:'记录已删除',icon:'success'});
      }catch(error){wx.showToast({title:error.message||'删除失败，请重试',icon:'none'});}
      finally{this.deletingDraft=false;}
    }});
  },
  goGallery() {
    wx.navigateTo({
      url: `/pages/project/gallery/index?projectId=${this.data.projectId}`
    });
  },
  toggleRecentInspection() {
    this.setData({
      recentInspectionExpanded: !this.data.recentInspectionExpanded
    });
  },
  toggleRecentReport() {
    this.setData({
      recentReportExpanded: !this.data.recentReportExpanded
    });
  },
});
