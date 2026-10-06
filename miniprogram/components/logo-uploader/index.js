const { requirePrivacy } = require("../../utils/privacy");

function showPermissionRecovery() {
  wx.showModal({
    title: "需要照片权限",
    content: "可以先不上传 LOGO；也可到微信设置中允许相册或相机后重试。",
    confirmText: "去设置",
    cancelText: "暂不上传",
    success(result) {
      if (result.confirm && typeof wx.openSetting === "function") wx.openSetting({});
    }
  });
}

Component({
  properties: {
    value: {
      type: String,
      value: ""
    },
    uploadedFileId: {
      type: String,
      value: ""
    },
    previewError: {
      type: Boolean,
      value: false
    }
  },
  methods: {
    handlePreviewError() {
      this.setData({ previewError: true });
    },
    async chooseLogo() {
      try {
        await requirePrivacy();
      } catch (error) {
        wx.showModal({
          title: "暂时无法选择 LOGO",
          content: `${(error && error.message) || "隐私授权未完成"}。可以先保存其他资料，稍后再上传。`,
          showCancel: false
        });
        return;
      }
      try {
        // chooseMedia 是当前微信基础库的主入口。旧版才回退到 chooseImage，
        // 避免系统文件选择器选中后回到页面却没有收到照片回调。
        let filePath = "";
        if (typeof wx.chooseMedia === "function") {
          const result = await new Promise((resolve, reject) => wx.chooseMedia({
            count: 1,
            mediaType: ["image"],
            sourceType: ["album", "camera"],
            success: resolve,
            fail: reject
          }));
          filePath = (result.tempFiles || []).map(item => item && item.tempFilePath).find(Boolean) || "";
        } else if (typeof wx.chooseImage === "function") {
          const result = await new Promise((resolve, reject) => wx.chooseImage({
            count: 1,
            sizeType: ["original"],
            sourceType: ["album", "camera"],
            success: resolve,
            fail: reject
          }));
          filePath = (result.tempFilePaths || []).find(Boolean) || "";
        } else {
          throw new Error("当前微信版本不支持选图，请升级后重试。");
        }
        if (!filePath) return;
        this.triggerEvent("change", filePath);
      } catch (error) {
        const text = `${(error && error.errMsg) || (error && error.message) || ""}`;
        if (/api scope is not declared in the privacy agreement/i.test(text) || `${error && error.errno}` === "112") {
          wx.showModal({
            title: "暂时无法选择图片",
            content: "此功能暂不可用，请稍后重试。你可以先填写其他资料。",
            showCancel: false
          });
          return;
        }
        if (/cancel/i.test(text)) {
          return;
        }
        if (/auth deny|authorize|permission|denied|reject|拒绝|未授权/i.test(text)) {
          showPermissionRecovery();
          return;
        }
        wx.showToast({
          title: "无法选择图片",
          icon: "none"
        });
      }
    }
  }
});
