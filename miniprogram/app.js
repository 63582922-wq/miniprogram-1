const { loginAndBootstrapUser } = require("./services/user");

App({
  globalData: {
    env: "cloud1-2gx2o7qj5893195c",
    userInfo: null,
    appReady: false,
    theme: {
      primary: "#2563EB",
      success: "#16A34A",
      warning: "#F59E0B",
      danger: "#DC2626"
    }
  },
  async onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: "基础库版本过低",
        content: "请使用 2.2.3 或以上基础库以启用云能力",
        showCancel: false
      });
      return;
    }

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await this.bootstrap();
  },
  async bootstrap() {
    try {
      const userInfo = await loginAndBootstrapUser();
      this.globalData.userInfo = userInfo;
      this.globalData.appReady = true;
    } catch (error) {
      this.globalData.appReady = false;
      console.error("[app] bootstrap failed", error);
      wx.showToast({
        title: (typeof error.message === "string" && error.message) ? error.message.slice(0, 64) : "初始化失败",
        icon: "none"
      });
    }
  }
});
