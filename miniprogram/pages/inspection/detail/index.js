const { getInspectionDetail } = require("../../../services/inspection");
const { isCloudFileId, resolveCloudFileUrls } = require("../../../services/cloud-media");
const { formatDateTime } = require("../../../utils/format");
const { decodeReturnContext, encodeReturnContext, returnToContext } = require("../../../utils/router");

Page({
  data: {
    inspectionId: "",
    returnContext: null,
    inspection: {},
    items: [],
    photos: [],
    reportId: "",
    loading: true,
    loadError: ""
  },
  async onLoad(query) {
    this.setData({
      inspectionId: query.inspectionId || "",
      returnContext: decodeReturnContext(query.returnContext) || null
    });
  },
  onShow() {
    if (this.data.inspectionId) {
      this.loadDetail();
    }
  },
  async loadDetail() {
    const generation = (this.detailLoadGeneration || 0) + 1;
    this.detailLoadGeneration = generation;
    this.setData({ loading: true, loadError: "" });
    try {
      const result = await getInspectionDetail(this.data.inspectionId);
      if (generation !== this.detailLoadGeneration) return;
      if (!result || !result.inspection) throw new Error("这条记录不存在或无权限访问");
      const rawPhotos = result.inspection.photos || [];
      const paths = rawPhotos.map(photo => photo.annotatedImagePath || photo.imagePath).filter(Boolean);
      const resolved = await resolveCloudFileUrls(paths.filter(isCloudFileId));
      if (generation !== this.detailLoadGeneration) return;
      const photos = rawPhotos.map((photo, index) => {
        const source = photo.annotatedImagePath || photo.imagePath || "";
        return {...photo, number:index + 1, previewUrl:isCloudFileId(source) ? (resolved.urls[source] || "") : source};
      });
      this.setData({
        inspection: {
          ...result.inspection,
          createdAtText: formatDateTime(result.inspection.createdAt),
          projectNameText: result.inspection.projectName || "未关联项目"
        },
        items: result.items || [],
        photos,
        reportId: result.report ? result.report._id : ""
      });
    } catch (error) {
      if (generation !== this.detailLoadGeneration) return;
      this.setData({
        inspection: {},
        items: [],
        photos: [],
        reportId: "",
        loadError: error.message || "记录加载失败，请重试"
      });
    } finally {
      if (generation === this.detailLoadGeneration) this.setData({ loading: false });
    }
  },
  handleBackTap() {
    returnToContext(this.data.returnContext);
  },
  previewPhoto(event) {
    const photo = this.data.photos[Number(event.currentTarget.dataset.index)];
    const urls = this.data.photos.map(item => item.previewUrl).filter(Boolean);
    if (photo && photo.previewUrl) wx.previewImage({current:photo.previewUrl, urls});
  },
  handleHomeTap() {
    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  goReport() {
    if (this.data.loading || this.data.loadError || !this.data.inspectionId) return;
    const returnContextQuery = encodeReturnContext(this.data.returnContext);
    wx.navigateTo({
      url: this.data.reportId
        ? `/pages/report/detail/index?reportId=${this.data.reportId}${returnContextQuery ? `&returnContext=${returnContextQuery}` : ""}`
        : `/pages/report/detail/index?inspectionId=${this.data.inspectionId}${returnContextQuery ? `&returnContext=${returnContextQuery}` : ""}`
    });
  }
});
