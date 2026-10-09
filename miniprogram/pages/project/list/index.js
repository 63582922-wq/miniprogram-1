const { listProjects, deleteProject } = require("../../../services/project");
// 只用 isGuideCompleted 决定空态按钮的文案；startCoach/getGuideProgress 在这里用不到，
// 此前 import 了却从未引用，已移除。
const { isGuideCompleted } = require("../../../utils/guide");
const { syncTabBar } = require("../../../utils/tab-bar");

Page({
  data: {
    keyword: "",loading:false,loadError:"",page:0,hasMore:false,
    projectList: [],
    onboardingActionText: "第一次用？看使用向导"
  },
  onShow(){
    syncTabBar(this,"pages/project/list/index");
    // 已完成向导的人不该再看到「第一次用？」——文案跟着状态走。
    this.setData({onboardingActionText:isGuideCompleted()?"查看使用向导":"第一次用？看使用向导"});
    this.loadProjects();
  },
  openOnboarding(){wx.navigateTo({url:"/pages/onboarding/index?source=projectList"});},
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
