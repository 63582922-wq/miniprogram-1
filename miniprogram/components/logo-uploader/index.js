const { requirePrivacy } = require("../../utils/privacy");

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
      } catch (_error) {
        return;
      }
      try {
        const result = await wx.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sourceType: ["album", "camera"]
        });

        const filePath = result.tempFiles[0].tempFilePath;
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
        wx.showToast({
          title: "无法选择图片",
          icon: "none"
        });
      }
    }
  }
});
