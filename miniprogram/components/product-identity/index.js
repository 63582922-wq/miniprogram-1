const { getWindowInfo } = require("../../utils/system");

Component({
  options: {
    addGlobalClass: true
  },
  properties: { title: { type: String, value: "" } },
  data: { statusBarHeight: 20, capsuleSafeWidth: 112 },
  lifetimes: {
    attached() {
      const info = getWindowInfo();
      const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
        ? wx.getMenuButtonBoundingClientRect() : null;
      this.setData({
        statusBarHeight: info.statusBarHeight || 20,
        capsuleSafeWidth: capsule ? Math.max(112, info.windowWidth - capsule.left + 16) : 112
      });
    }
  }
});
