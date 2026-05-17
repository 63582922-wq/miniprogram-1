Component({
  properties: {
    title: {
      type: String,
      value: ""
    },
    showBack: {
      type: Boolean,
      value: false
    },
    autoBack: {
      type: Boolean,
      value: true
    },
    actionSide: {
      type: String,
      value: "right"
    },
    actionIconOnly: {
      type: Boolean,
      value: false
    },
    rightText: {
      type: String,
      value: ""
    }
  },
  data: {
    statusBarHeight: 20,
    navContentHeight: 44,
    capsuleSafeWidth: 112
  },
  lifetimes: {
    attached() {
      this.computeMetrics();
    }
  },
  methods: {
    computeMetrics() {
      try {
        const systemInfo = wx.getSystemInfoSync();
        const menuButton = typeof wx.getMenuButtonBoundingClientRect === "function"
          ? wx.getMenuButtonBoundingClientRect()
          : null;

        const statusBarHeight = systemInfo.statusBarHeight || 20;
        const navContentHeight = menuButton
          ? (menuButton.top - statusBarHeight) * 2 + menuButton.height
          : 44;
        const capsuleSafeWidth = menuButton
          ? Math.max(112, systemInfo.windowWidth - menuButton.left + 16)
          : 112;

        this.setData({
          statusBarHeight,
          navContentHeight,
          capsuleSafeWidth
        });
      } catch (error) {
        this.setData({
          statusBarHeight: 20,
          navContentHeight: 44,
          capsuleSafeWidth: 112
        });
      }
    },
    handleRightTap() {
      this.triggerEvent("righttap");
    },
    handleBackTap() {
      this.triggerEvent("backtap");
      if (!this.data.autoBack) {
        return;
      }
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({
          delta: 1
        });
      }
    }
  }
});
