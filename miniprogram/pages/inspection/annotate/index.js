Page({
  data: {
    sessionKey: "",
    issueId: "",
    issueIndex: -1,
    imagePath: "",
    annotations: [],
    annotationStage: null
  },
  onLoad(query) {
    this.setData({
      sessionKey: query.sessionKey || "",
      issueId: decodeURIComponent(query.issueId || "")
    });
    this.loadIssue();
  },
  loadIssue() {
    const form = wx.getStorageSync(this.data.sessionKey);
    const issueDrafts = form && form.issueDrafts ? form.issueDrafts : [];
    const issueIndex = issueDrafts.findIndex((item) => item.id === this.data.issueId);
    const issue = issueDrafts[issueIndex];

    if (!issue) {
      wx.showToast({
        title: "照片草稿不存在",
        icon: "none"
      });
      setTimeout(() => {
        wx.navigateBack();
      }, 300);
      return;
    }

    this.setData({
      issueIndex,
      imagePath: issue.imagePath,
      annotations: issue.annotations || [],
      annotationStage: issue.annotationStage || null
    });
  },
  handleAnnotationChange(event) {
    this.setData({
      annotations: event.detail
    });
  },
  handleStageChange(event) {
    this.setData({
      annotationStage: event.detail || null
    });
  },
  handleBackTap() {
    wx.navigateBack({
      delta: 1
    });
  },
  handleHomeTap() {
    wx.showModal({
      title: "返回首页",
      content: "未保存的标注会丢失，确认回首页吗？",
      success: (result) => {
        if (!result.confirm) {
          return;
        }
        wx.switchTab({
          url: "/pages/project/list/index"
        });
      }
    });
  },
  async createAnnotatedImage() {
    if (!this.data.imagePath || !this.data.annotationStage) {
      return "";
    }

    const imageInfo = await wx.getImageInfo({
      src: this.data.imagePath
    });
    const stage = this.data.annotationStage;
    const scale = imageInfo.width / stage.width;

    const query = wx.createSelectorQuery();
    const canvasNode = await new Promise((resolve, reject) => {
      query.select("#exportCanvas").fields({ node: true, size: true }).exec((result) => {
        const target = result && result[0];
        if (!target || !target.node) {
          reject(new Error("导出画布不可用"));
          return;
        }
        resolve(target.node);
      });
    });

    canvasNode.width = imageInfo.width;
    canvasNode.height = imageInfo.height;
    const ctx = canvasNode.getContext("2d");
    const image = canvasNode.createImage();

    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = imageInfo.path;
    });

    ctx.clearRect(0, 0, imageInfo.width, imageInfo.height);
    ctx.drawImage(image, 0, 0, imageInfo.width, imageInfo.height);

    (this.data.annotations || []).forEach((item) => {
      if (item.tool === "box") {
        ctx.strokeStyle = "#FF6B57";
        ctx.lineWidth = Math.max(4, scale * 4);
        const radius = Math.max(12, scale * 12);
        const x = item.x * scale;
        const y = item.y * scale;
        const width = item.width * scale;
        const height = item.height * scale;
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + width, y, x + width, y + height, radius);
        ctx.arcTo(x + width, y + height, x, y + height, radius);
        ctx.arcTo(x, y + height, x, y, radius);
        ctx.arcTo(x, y, x + width, y, radius);
        ctx.closePath();
        ctx.stroke();
        return;
      }

      if (item.tool === "arrow") {
        const x1 = item.x * scale;
        const y1 = item.y * scale;
        const x2 = item.x2 * scale;
        const y2 = item.y2 * scale;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const lineWidth = Math.max(6, scale * 8);
        const headLength = Math.max(18, scale * 20);
        const headHalf = Math.max(12, scale * 14);

        ctx.strokeStyle = "#FF6B57";
        ctx.fillStyle = "#FF6B57";
        ctx.lineWidth = lineWidth;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(
          x2 - headLength * Math.cos(angle) - headHalf * Math.sin(angle),
          y2 - headLength * Math.sin(angle) + headHalf * Math.cos(angle)
        );
        ctx.lineTo(
          x2 - headLength * Math.cos(angle) + headHalf * Math.sin(angle),
          y2 - headLength * Math.sin(angle) - headHalf * Math.cos(angle)
        );
        ctx.closePath();
        ctx.fill();
        return;
      }

      if (item.tool === "text") {
        const x = item.x * scale;
        const y = item.y * scale;
        const text = item.text || "问题";
        const fontSize = Math.max(24, scale * 24);
        const horizontalPadding = Math.max(16, scale * 18);
        const verticalPadding = Math.max(10, scale * 10);
        const radius = Math.max(12, scale * 12);

        ctx.font = `600 ${fontSize}px sans-serif`;
        const textWidth = ctx.measureText(text).width;
        const boxWidth = textWidth + horizontalPadding * 2;
        const boxHeight = fontSize + verticalPadding * 2;
        const left = x - boxWidth / 2;
        const top = y - boxHeight / 2;

        ctx.fillStyle = "rgba(255, 107, 87, 0.94)";
        ctx.beginPath();
        ctx.moveTo(left + radius, top);
        ctx.arcTo(left + boxWidth, top, left + boxWidth, top + boxHeight, radius);
        ctx.arcTo(left + boxWidth, top + boxHeight, left, top + boxHeight, radius);
        ctx.arcTo(left, top + boxHeight, left, top, radius);
        ctx.arcTo(left, top, left + boxWidth, top, radius);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#FFFFFF";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(text, left + horizontalPadding, top + verticalPadding);
      }
    });

    return await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: canvasNode,
        fileType: "png",
        quality: 1,
        destWidth: imageInfo.width,
        destHeight: imageInfo.height,
        success: (res) => resolve(res.tempFilePath || ""),
        fail: reject
      });
    });
  },
  async handleSave() {
    const form = wx.getStorageSync(this.data.sessionKey);
    const issueDrafts = form && form.issueDrafts ? form.issueDrafts : [];

    if (this.data.issueIndex < 0 || !issueDrafts[this.data.issueIndex]) {
      wx.showToast({
        title: "保存失败",
        icon: "none"
      });
      return;
    }

    let annotatedImagePath = issueDrafts[this.data.issueIndex].annotatedImagePath || "";
    try {
      annotatedImagePath = await this.createAnnotatedImage();
    } catch (error) {
      wx.showToast({
        title: "标注图片导出失败",
        icon: "none"
      });
      return;
    }

    issueDrafts[this.data.issueIndex] = {
      ...issueDrafts[this.data.issueIndex],
      annotations: this.data.annotations,
      annotationStage: this.data.annotationStage,
      annotatedImagePath
    };

    wx.setStorageSync(this.data.sessionKey, {
      ...form,
      issueDrafts
    });

    if (typeof wx.disableAlertBeforeUnload === "function") {
      wx.disableAlertBeforeUnload();
    }

    wx.navigateBack();
  }
});
