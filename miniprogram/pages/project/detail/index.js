const { getProjectDetail, getProjectGallery } = require("../../../services/project");
const { formatDateTime, mapProjectStatusText, usesEditorialTypeface } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");
const { listDrafts } = require("../../../utils/inspection-draft");

Page({
  data: {
    loading:true,loadError:"",
    projectId: "",drafts:[],
    project: {},
    recentInspectionExpanded: false,
    recentReportExpanded: false,
    workspaceStats: {
      inspections: 0,
      reports: 0
    },
    inspections: [],
    reports: [],
    latestInspection: null,
    latestReport: null,
    featurePhoto: null,
    featurePhotoCount: 0,
    progressTitle: "准备开始",
    progressText: "还没有现场记录",
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
    this.setData({loading:true,loadError:""});
    try {
      const [result, galleryResult] = await Promise.all([
        getProjectDetail(this.data.projectId),
        getProjectGallery(this.data.projectId).catch(() => null)
      ]);
      if(!result.project || result.project._id !== this.data.projectId)throw new Error("项目不存在或无权限，请返回重试");
      const drafts = listDrafts(this.data.projectId).map(d=>({...d,timeText:formatDateTime(d.updatedAt)}));
      const inspections = result.inspections || [];
      const reports = result.reports || [];
      const galleryPhotos = galleryResult && Array.isArray(galleryResult.photos) ? galleryResult.photos : [];
      const latestPhoto = galleryPhotos[0];
      const featurePhoto = latestPhoto ? {
        ...latestPhoto,
        titleText: latestPhoto.area || latestPhoto.category || latestPhoto.inspectionTitle || "现场记录",
        descriptionText: latestPhoto.description || latestPhoto.voiceText || "最近一次现场记录",
        createdAtText: formatDateTime(latestPhoto.createdAt),
        locationText: (result.project && result.project.address) || ""
      } : null;
      const draftPhotoCount = drafts.reduce((total, draft) => total + Number(draft.issueCount || 0), 0);
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
        inspections: inspections.map((item) => ({
          ...item,
          createdAtText: formatDateTime(item.createdAt)
        })),
        reports: reports.map((item) => ({
          ...item,
          generatedAtDisplay: formatDateTime(item.generatedAt || item.createdAt) || "待生成"
        })),
        latestInspection: inspections.length ? {
          ...inspections[0],
          createdAtText: formatDateTime(inspections[0].createdAt)
        } : null,
        latestReport: reports.length ? {
          ...reports[0],
          generatedAtDisplay: formatDateTime(reports[0].generatedAt || reports[0].createdAt) || "待生成"
        } : null,
        workspaceStats: {
          inspections: inspections.length,
          reports: reports.length
        },
        featurePhoto,
        featurePhotoCount: galleryPhotos.length,
        progressTitle: drafts.length ? "现场记录中" : (inspections.length ? "最近已记录" : "准备开始"),
        progressText: drafts.length
          ? `未完成 ${drafts.length} 次 · 已拍 ${draftPhotoCount} 张`
          : (inspections.length ? `已完成 ${inspections.length} 次现场记录` : "还没有现场记录")
      });
    } catch (error) {
      this.setData({loadError:error.message||"项目加载失败"});
      wx.showToast({
        title: error.message || "加载失败",
        icon: "none"
      });
    } finally{this.setData({loading:false});}
  },
  goEdit() {
    wx.navigateTo({
      url: `/pages/project/form/index?projectId=${this.data.projectId}`
    });
  },
  goInspectionCreate() {
    if (this.data.loading || this.data.loadError) return;
    const newestDraft = this.data.drafts[0];
    if (newestDraft) {
      this.navigateToRecord(newestDraft.sessionKey);
      return;
    }
    this.goNewInspection();
  },
  goNewInspection() {
    if (this.data.loading || this.data.loadError) return;
    this.navigateToRecord("");
  },
  navigateToRecord(sessionKey = "") {
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
  goGallery() {
    wx.navigateTo({
      url: `/pages/project/gallery/index?projectId=${this.data.projectId}`
    });
  },
  previewFeaturePhoto() {
    const photo = this.data.featurePhoto;
    if (!photo || !photo.imageUrl) return;
    wx.previewImage({ current: photo.imageUrl, urls: [photo.imageUrl] });
  },
  goInspectionList() {
    wx.navigateTo({
      url: `/pages/inspection/list/index?projectId=${this.data.projectId}&projectName=${encodeURIComponent(this.data.project.name || "")}`
    });
  },
  goReportList() {
    // 统一走报告列表页（它已支持按项目筛选），不再维护一份重复的项目报告页
    wx.setStorageSync("pendingReportContext", {
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      source: "projectDetail"
    });
    wx.switchTab({
      url: "/pages/report/list/index"
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
  openInspection(event) {
    const inspectionId = event.currentTarget.dataset.inspectionId;
    const returnContext = encodeReturnContext({
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      returnTarget: "projectDetail"
    });
    wx.navigateTo({
      url: `/pages/inspection/detail/index?inspectionId=${inspectionId}&returnContext=${returnContext}`
    });
  },
  openReport(event) {
    const reportId = event.currentTarget.dataset.reportId;
    const returnContext = encodeReturnContext({
      projectId: this.data.projectId,
      projectName: this.data.project.name || "",
      returnTarget: "projectDetail"
    });
    wx.navigateTo({
      url: `/pages/report/detail/index?reportId=${reportId}&returnContext=${returnContext}`
    });
  }
});
