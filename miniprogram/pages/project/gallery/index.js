const { getProjectGallery } = require("../../../services/project");
const { formatDateTime } = require("../../../utils/format");

Page({
  data: {
    projectId: "",
    project: {},
    stats: {
      total: 0,
      inspectionsTotal: 0
    },
    photos: []
  },
  onLoad(query) {
    this.setData({
      projectId: query.projectId || ""
    });
  },
  onShow() {
    if (this.data.projectId) {
      this.loadGallery();
    }
  },
  async loadGallery() {
    try {
      const result = await getProjectGallery(this.data.projectId);
      this.setData({
        project: {
          ...(result.project || {}),
          nameText: (result.project && result.project.name) || "项目巡查相册"
        },
        stats: {
          total: result.total || 0,
          inspectionsTotal: result.inspectionsTotal || 0
        },
        photos: (result.photos || []).map((item) => ({
          ...item,
          createdAtText: formatDateTime(item.createdAt),
          areaText: item.area || item.category || "现场照片"
        }))
      });
    } catch (error) {
      wx.showToast({
        title: error.message || "相册加载失败",
        icon: "none"
      });
    }
  },
  previewPhoto(event) {
    const { current } = event.currentTarget.dataset;
    const urls = (this.data.photos || []).map((item) => item.imageUrl);
    wx.previewImage({
      current,
      urls
    });
  },
  openInspection(event) {
    const { inspectionId } = event.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/inspection/detail/index?inspectionId=${inspectionId}`
    });
  }
});
