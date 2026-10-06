const { getProjectGallery } = require("../../../services/project");
const { isCloudFileId, resolveCloudFileUrls } = require("../../../services/cloud-media");
const { formatDateTime } = require("../../../utils/format");

Page({
  data: {
    projectId: "",
    loading: true,
    loadError: "",
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
    const generation = (this.galleryLoadGeneration || 0) + 1;
    this.galleryLoadGeneration = generation;
    this.setData({loading:true,loadError:""});
    try {
      const result = await getProjectGallery(this.data.projectId);
      const rawPhotos = result.photos || [];
      const fileIds = rawPhotos.map(item => item.imageUrl).filter(isCloudFileId);
      const resolved = await resolveCloudFileUrls(fileIds);
      if (generation !== this.galleryLoadGeneration) return;
      this.setData({
        project: {
          ...(result.project || {}),
          nameText: (result.project && result.project.name) || "项目巡查相册"
        },
        stats: {
          total: result.total || 0,
          inspectionsTotal: result.inspectionsTotal || 0
        },
        photos: rawPhotos.map((item) => ({
          ...item,
          imageFileId: item.imageUrl || "",
          imageUrl: isCloudFileId(item.imageUrl) ? (resolved.urls[item.imageUrl] || "") : (item.imageUrl || ""),
          imageError: Boolean(item.imageUrl && isCloudFileId(item.imageUrl) && !resolved.urls[item.imageUrl]),
          createdAtText: formatDateTime(item.createdAt),
          areaText: item.area || item.category || "现场照片"
        }))
      });
    } catch (error) {
      if (generation === this.galleryLoadGeneration) {
        this.setData({loadError: error.message || "相册加载失败"});
      }
    } finally {
      if (generation === this.galleryLoadGeneration) this.setData({loading:false});
    }
  },
  previewPhoto(event) {
    const { current } = event.currentTarget.dataset;
    const urls = (this.data.photos || []).map((item) => item.imageUrl).filter(Boolean);
    if (!current || !urls.length) return;
    wx.previewImage({
      current,
      urls
    });
  },
  handlePhotoError(event) {
    const index = Number(event.currentTarget.dataset.index);
    const photos = [...(this.data.photos || [])];
    if (!photos[index]) return;
    photos[index] = {...photos[index], imageUrl:"", imageError:true};
    this.setData({photos});
  },
  openInspection(event) {
    const { inspectionId } = event.currentTarget.dataset;
    wx.navigateTo({
      url: `/pages/inspection/detail/index?inspectionId=${inspectionId}`
    });
  }
});
