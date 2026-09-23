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
    }
  },
  methods: {
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
        // Match the evidence picker: chooseImage has a stable callback in the
        // developer tool and allows a user to keep a sharp source logo.
        const filePath = typeof wx.chooseImage === "function"
          ? await new Promise((resolve, reject) => wx.chooseImage({
            count: 1, sizeType: ["original"], sourceType: ["album", "camera"],
            success: (result) => resolve((result.tempFilePaths || [])[0] || ""), fail: reject
          }))
          : (await wx.chooseMedia({count:1,mediaType:["image"],sourceType:["album","camera"]})).tempFiles[0].tempFilePath;
        if (!filePath) return;
        this.triggerEvent("change", filePath);
      } catch (error) {
        const text = `${(error && error.errMsg) || (error && error.message) || ""}`;
        if (/api scope is not declared in the privacy agreement/i.test(text) || `${error && error.errno}` === "112") {
          wx.showModal({
            title: "需完善隐私声明",
            content: "当前小程序后台未声明“相机/相册”用途，请先在微信公众平台补充隐私指引后再试。",
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
