const { listProjects, deleteProject } = require("../../../services/project");
const { isGuideCompleted } = require("../../../utils/guide");
// 向导看没看过。onboarding 页在退出时写这个标记，此前没有任何地方读它——
// 于是「首次自动进入」这件事一直没生效。
const ONBOARDING_SEEN_KEY = "onboardingSeenV1";
const { syncTabBar } = require("../../../utils/tab-bar");

Page({
  data: {
    keyword: "",loading:false,loadError:"",page:0,hasMore:false,
    projectList: []
  },
  onShow(){
    syncTabBar(this,"pages/project/list/index");
    // 等项目列表回来再判断要不要进向导：已有项目的人不该被打扰。
    this.loadProjects().then(()=>this.autoOpenGuideOnce()).catch(()=>{});
  },
  /**
   * 首次使用自动进一次向导；之后再想看，去「我的 → 使用说明」。
   *
   * 三个条件同时成立才算首次：没看过向导、向导尚未完成、手上没有任何项目。
   * 进入前就把标记落下——否则用户中途退出，下次启动还会再弹一次。
   */
  autoOpenGuideOnce(){
    if(wx.getStorageSync(ONBOARDING_SEEN_KEY))return;
    if(isGuideCompleted()||(this.data.projectList||[]).length){
      wx.setStorageSync(ONBOARDING_SEEN_KEY,true);
      return;
    }
    wx.setStorageSync(ONBOARDING_SEEN_KEY,true);
    wx.navigateTo({url:"/pages/onboarding/index?source=firstRun"});
  },
  onReachBottom(){if(this.data.hasMore)this.loadProjects(true);},
  async loadProjects(append=false){
    append=append===true;if(append&&this.data.loading)return;
    const sequence = this.loadSequence = (this.loadSequence || 0) + 1;
    this.setData({loading:true,loadError:""});
    try{const result=await listProjects({keyword:this.data.keyword,page:append?this.data.page+1:1,pageSize:20});
      if(sequence!==this.loadSequence)return;
      this.setData({projectList:append?this.data.projectList.concat(result.list||[]):result.list||[],page:result.page||1,hasMore:!!result.hasMore});
    }catch(e){if(sequence===this.loadSequence)this.setData({loadError:e.message||"项目加载失败，请重试"});}
    finally{if(sequence===this.loadSequence)this.setData({loading:false});}
  },
  handleKeywordInput(event) {
    this.setData({
      keyword: event.detail.value
    });
  },
  handleSearch() {
    this.loadProjects();
  },
  goCreate() {
    wx.navigateTo({
      url: "/pages/project/form/index"
    });
  },
  openDetail(event) {
    const { _id } = event.detail;
    wx.navigateTo({
      url: `/pages/project/detail/index?projectId=${_id}`
    });
  },
  async handleProjectLongPress(event) {
    const project = event.detail || {};
    const projectId = project._id || event.currentTarget.dataset.projectId;
    const projectName = project.name || event.currentTarget.dataset.projectName || "该项目";
    if (!projectId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除项目"],
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
          title: "删除项目",
          content: `确定删除“${projectName}”吗？删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteProject(projectId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadProjects();
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
