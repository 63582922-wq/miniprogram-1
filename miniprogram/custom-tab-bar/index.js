const { requirePrivacy } = require("../utils/privacy");
const { listProjects } = require("../services/project");

Component({
  methods: {
    /**
     * 开相机之前先确认有项目可挂靠。
     *
     * 「拍照」是 tab 上的一个动作，但巡查结果必须归属到某个项目。
     * 原实现直接把用户丢进巡查创建页，没有项目时要在那里才发现，
     * 照片已经拍完了却没有归属，只能干瞪眼。
     *
     * 查不到就放行——不要因为一次查询失败挡住用户拍照。
     */
    async ensureProjectBeforeCapture() {
      try {
        const result = await listProjects({ pageSize: 1 });
        const projects = (result && result.list) || [];

        if (projects.length) {
          return true;
        }

        wx.showModal({
          title: "还没有项目",
          content: "巡查结果要归属到一个项目，请先创建项目，再回来拍照。",
          confirmText: "去创建",
          cancelText: "取消",
          success: (res) => {
            if (res.confirm) {
              wx.navigateTo({
                url: "/pages/project/form/index"
              });
            }
          }
        });
        return false;
      } catch (error) {
        console.warn("[tab-bar] 项目检查失败，继续拍照流程", error);
        return true;
      }
    },

    openCamera() {
      wx.chooseMedia({
        count: 9,
        mediaType: ["image"],
        sourceType: ["album", "camera"],
        success: (res) => {
          const photos = res.tempFiles.map((item) => item.tempFilePath);
          wx.setStorageSync("pendingPhotos", photos);
          wx.navigateTo({
            url: "/pages/inspection/create/index"
          });
        },
        fail: (error) => {
          this.handleChooseMediaError(error);
        }
      });
    },

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
        requirePrivacy()
          .then(async () => {
            const canCapture = await this.ensureProjectBeforeCapture();
            if (!canCapture) {
              return;
            }
            this.openCamera();
          })
          .catch(() => {});
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
