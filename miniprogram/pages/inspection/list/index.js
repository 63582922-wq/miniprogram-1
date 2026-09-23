const { listInspections, deleteInspection } = require("../../../services/inspection");
const { formatDateTime } = require("../../../utils/format");
const { encodeReturnContext } = require("../../../utils/router");
const { openRecord } = require("../../../utils/record-entry");

Page({
  data: {
    inspectionList: [],loading:false,loadError:"",page:0,hasMore:false,
    projectId: "",
    projectName: "",
    pageTitle: "巡查"
  },
  onLoad(query) {
    const projectId = query.projectId || "";
    const projectName = query.projectName ? decodeURIComponent(query.projectName) : "";
    this.setData({
      projectId,
      projectName,
      pageTitle: projectName ? `${projectName}巡查` : "巡查"
    });
  },
  onShow() {
    this.loadInspections();
  },
  onReachBottom(){if(this.data.hasMore)this.loadInspections(true);},
  async loadInspections(append=false) {
    append = append === true;
    if(this.data.loading)return;
    this.setData({loading:true,loadError:""});
    try {
      const result = await listInspections({
        projectId: this.data.projectId,
        page: append ? this.data.page + 1 : 1,
        pageSize: 20
      });
      const rows=(result.list || []).map((item) => ({
          ...item,
          createdAtText: formatDateTime(item.createdAt),
          projectNameText: item.projectName || "未关联项目"
        }));
      this.setData({inspectionList:append?this.data.inspectionList.concat(rows):rows,page:result.page||1,hasMore:!!result.hasMore});
    } catch (error) {
      this.setData({loadError:error.message||"巡查记录加载失败，请重试"});
    } finally {this.setData({loading:false});}
  },
  goCreate() {
    openRecord(this.data.projectId, this.data.projectName, "inspectionList").catch(e=>wx.showToast({title:e.message,icon:"none"}));
  },
  openDetail(event) {
    const inspectionId = event.currentTarget.dataset.inspectionId;
    const returnContext = this.data.projectId
      ? encodeReturnContext({
        projectId: this.data.projectId,
        projectName: this.data.projectName || "",
        returnTarget: "inspectionList"
      })
      : "";
    wx.navigateTo({
      url: `/pages/inspection/detail/index?inspectionId=${inspectionId}${returnContext ? `&returnContext=${returnContext}` : ""}`
    });
  },
  async handleInspectionLongPress(event) {
    const inspectionId = event.currentTarget.dataset.inspectionId;
    const inspectionTitle = event.currentTarget.dataset.inspectionTitle || "该巡查";
    if (!inspectionId) {
      return;
    }

    wx.vibrateShort({
      type: "light"
    });

    try {
      const actionResult = await new Promise((resolve, reject) => {
        wx.showActionSheet({
          itemList: ["删除巡查"],
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
          title: "删除巡查",
          content: `确定删除“${inspectionTitle}”吗？关联问题项和报告也会一起移除，删除后不能恢复。`,
          confirmText: "删除",
          confirmColor: "#FF3B30",
          cancelText: "取消",
          success: resolve
        });
      });

      if (!confirmResult.confirm) {
        return;
      }

      await deleteInspection(inspectionId);
      wx.showToast({
        title: "已删除",
        icon: "success"
      });
      this.loadInspections();
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
