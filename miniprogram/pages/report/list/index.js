const { listReports, deleteReport } = require("../../../services/report");
const { listProjects } = require("../../../services/project");
const { formatDateTime } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");
const { syncTabBar } = require("../../../utils/tab-bar");

const PENDING_REPORT_CONTEXT_KEY = "pendingReportContext";
const LAST_REPORT_CONTEXT_KEY = "lastReportContext";

Page({
  data: {
    loading:false,loadError:"",page:0,hasMore:false,
    projectPage:0,projectHasMore:false,
    projectId: "",
    projectName: "",
    pageTitle: "全部报告",
    isProjectMode: false,
    entrySource: "",
    reports: [],
    projects: []
  },
  onLoad(query) {
    const projectName = query.projectName ? decodeURIComponent(query.projectName) : "";
    this.setData({
      projectId: query.projectId || "",
      projectName,
      isProjectMode: false,
      pageTitle: query.projectId ? "项目报告" : "全部报告"
    });
  },
  onShow() {
    syncTabBar(this, "pages/report/list/index");
    if (this.applyStoredContext()) {
      this.loadReports();
      return;
    }

    if (this.data.isProjectMode) {
      this.loadProjects();
      return;
    }
    this.loadReports();
  },
  applyStoredContext() {
    const pending = wx.getStorageSync(PENDING_REPORT_CONTEXT_KEY);
    if (pending && pending.projectId) {
      wx.removeStorageSync(PENDING_REPORT_CONTEXT_KEY);
      this.applyProjectContext(pending.projectId, pending.projectName || "", pending.source || "");
      this.persistProjectContext(pending.projectId, pending.projectName || "");
      return true;
    }

    return false;
  },
  applyProjectContext(projectId, projectName, entrySource = "") {
    this.setData({
      projectId,
      projectName,
      isProjectMode: false,
      entrySource,
      pageTitle: projectId ? "项目报告" : "全部报告"
    });
  },
  persistProjectContext(projectId, projectName) {
    if (!projectId) {
      wx.removeStorageSync(LAST_REPORT_CONTEXT_KEY);
      return;
    }
    wx.setStorageSync(LAST_REPORT_CONTEXT_KEY, {
      projectId,
      projectName
    });
  },
  onReachBottom(){
    if(this.data.isProjectMode&&this.data.projectHasMore){this.loadProjects(true);return;}
    if(!this.data.isProjectMode&&this.data.hasMore)this.loadReports(true);
  },
  retryLoad(){return this.data.isProjectMode?this.loadProjects():this.loadReports();},
  async loadProjects(append=false){
    append=append===true;if(this.data.loading)return;this.setData({loading:true,loadError:"",hasMore:false});
    try{const r=await listProjects({page:append?this.data.projectPage+1:1,pageSize:20});this.setData({projects:append?this.data.projects.concat(r.list||[]):r.list||[],projectPage:r.page||1,projectHasMore:!!r.hasMore});}
    catch(e){this.setData({loadError:e.message||"加载失败"});}
    finally{this.setData({loading:false});}
  },
  async loadReports(append=false){
    append=append===true;if(append&&this.data.loading)return;const sequence=this.sequence=(this.sequence||0)+1;this.setData({loading:true,loadError:""});
    try{const r=await listReports({projectId:this.data.projectId,page:append?this.data.page+1:1,pageSize:20});
      if(sequence!==this.sequence)return;
      const rows=(r.list||[]).map(i=>{
        const title=`${i.title||""}`.trim();
        const projectTitle=title.replace(/巡查报告$/,"").trim();
        return {...i,displayTitle:projectTitle||title||"未命名项目",generatedAtDisplay:formatDateTime(i.publishedAt||i.createdAt||i.generatedAt)||""};
      });
      this.setData({reports:append?this.data.reports.concat(rows):rows,page:r.page||1,hasMore:!!r.hasMore});
    }catch(e){if(sequence===this.sequence)this.setData({loadError:e.message||"加载失败"});}
    finally{if(sequence===this.sequence)this.setData({loading:false});}
  },
  openProjectReports(event) {
    const { projectId, projectName } = event.currentTarget.dataset;
    this.applyProjectContext(projectId, projectName || "", "");
    this.persistProjectContext(projectId, projectName || "");
    this.loadReports();
  },
  switchProjectMode() {
    this.applyProjectContext("", "", "");
    this.persistProjectContext("", "");
    this.setData({
      reports: [],projectPage:0,projectHasMore:false
    });
    this.loadReports();
  },
  async chooseFilter(){
    try{const r=await listProjects();this.setData({filterProjects:r.list||[],filterVisible:true});}
    catch(e){wx.showToast({title:e.message||"项目加载失败",icon:"none"});}
  },
  closeFilter(){this.setData({filterVisible:false});},
  selectFilter(e){const id=e.currentTarget.dataset.id;const p=(this.data.filterProjects||[]).find(x=>x._id===id);this.applyProjectContext(id||"",p?p.name:"");this.closeFilter();this.loadReports();},
  handleBackTap() {
    if (this.data.entrySource === "projectDetail" && this.data.projectId) {
      wx.navigateTo({
        url: `/pages/project/detail/index?projectId=${this.data.projectId}`
      });
      return;
    }

    if (!this.data.isProjectMode) {
      this.switchProjectMode();
      return;
    }

    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  openReport(event) {
    const reportId = event.currentTarget.dataset.reportId;
    const returnContext = this.data.projectId
      ? encodeReturnContext({
        projectId: this.data.projectId,
        projectName: this.data.projectName || "",
        returnTarget: this.data.entrySource === "projectDetail" ? "projectDetail" : "reportList",
        source: this.data.entrySource || ""
      })
      : "";
    wx.navigateTo({
      url: `/pages/report/detail/index?reportId=${reportId}${returnContext ? `&returnContext=${returnContext}` : ""}`
    });
  },
  async handleReportLongPress(event) {
    const reportId = event.currentTarget.dataset.reportId;
    const reportTitle = event.currentTarget.dataset.reportTitle || "该报告";
    if (!reportId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除报告"],
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
          title: "删除报告",
          content: `确定删除“${reportTitle}”吗？删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteReport(reportId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadReports();
    } catch (error) {
      if (error && /cancel/i.test(error.errMsg || "")) {
        return;
      }
      wx.showToast({
        title: error.message || "删除失败",
        icon: "none"
      });
    }
  }
});
