const { getInspectionDetail } = require("../../../services/inspection");
const { formatDateTime } = require("../../../utils/format");
const { decodeReturnContext, encodeReturnContext, returnToContext } = require("../../../utils/router");

Page({
  data: {
    inspectionId: "",
    returnContext: null,
    inspection: {},
    items: [],
    reportId: ""
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
    const result = await getInspectionDetail(this.data.inspectionId);
    this.setData({
      inspection: {
        ...result.inspection,
        createdAtText: formatDateTime(result.inspection.createdAt),
        projectNameText: result.inspection.projectName || "未关联项目"
      },
      items: result.items || [],
      reportId: result.report ? result.report._id : ""
    });
  },
  handleBackTap() {
    returnToContext(this.data.returnContext);
  },
  handleHomeTap() {
    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  goReport() {
    const returnContextQuery = encodeReturnContext(this.data.returnContext);
    wx.navigateTo({
      url: this.data.reportId
        ? `/pages/report/detail/index?reportId=${this.data.reportId}${returnContextQuery ? `&returnContext=${returnContextQuery}` : ""}`
        : `/pages/report/detail/index?inspectionId=${this.data.inspectionId}${returnContextQuery ? `&returnContext=${returnContextQuery}` : ""}`
    });
  }
});
