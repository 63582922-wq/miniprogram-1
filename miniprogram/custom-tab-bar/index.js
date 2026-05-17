const { requirePrivacy } = require("../utils/privacy");

Component({
  methods: {
    handleChooseMediaError(error) {
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
        title: "无法打开相机或相册",
        icon: "none"
      });
    },
    switchTab(event) {
      const pagePath = event.currentTarget.dataset.path;
      if (!pagePath || pagePath === this.data.selected) {
        return;
      }

      if (pagePath === "action:take_photo") {
        requirePrivacy().then(() => {
          wx.chooseMedia({
            count: 9,
            mediaType: ["image"],
            sourceType: ["album", "camera"],
            success: (res) => {
              const photos = res.tempFiles.map(item => item.tempFilePath);
              wx.setStorageSync("pendingPhotos", photos);
              wx.navigateTo({
                url: "/pages/inspection/create/index"
              });
            },
            fail: (error) => {
              this.handleChooseMediaError(error);
            }
          });
        }).catch(() => {});
        return;
      }

      if (pagePath === "pages/memo/list/index") {
        wx.setStorageSync("pendingMemoContext", {
          projectId: "",
          projectName: "",
          scope: "all"
        });
      }

      wx.switchTab({
        url: `/${pagePath}`
      });
    }
  },
  data: {
    selected: "",
    list: [
      {
        pagePath: "pages/project/list/index",
        text: "项目",
        iconName: "project"
      },
      {
        pagePath: "pages/memo/list/index",
        text: "待办",
        iconName: "memo"
      },
      {
        pagePath: "action:take_photo",
        text: "拍照",
        isPrimary: true
      },
      {
        pagePath: "pages/report/list/index",
        text: "报告",
        iconName: "report"
      },
      {
        pagePath: "pages/profile/index",
        text: "我的",
        iconName: "profile"
      }
    ]
  },
  pageLifetimes: {
    show() {
      const pages = getCurrentPages();
      const currentPage = pages[pages.length - 1];
      this.setData({
        selected: currentPage ? currentPage.route : ""
      });
    }
  }
});
