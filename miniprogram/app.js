const { loginAndBootstrapUser } = require("./services/user");
const { setupPrivacyListener } = require("./utils/privacy");
const { PRIVACY_CONSENT_KEY } = require("./utils/privacy-consent");
const {
  getCloudEnvId,
  isCloudEnvConfigured,
  isCloudEnvError
} = require("./config/env");

App({
  globalData: {
    /** 当前云环境 ID，来自 config/env.js */
    env: "",
    userInfo: null,
    appReady: false,
    /**
     * 启动阶段的致命错误。
     * 页面可以据此区分「后端不可用」和「确实没有数据」，
     * 避免把前者的空结果渲染成「暂无项目」误导用户。
     */
    bootError: null
  },

  async onLaunch() {
    setupPrivacyListener();
    if (!wx.cloud) {
      this.showFatal(
        "请更新微信",
        "当前微信版本暂不支持此功能，请更新后重试。"
      );
      return;
    }

    if (!isCloudEnvConfigured()) {
      this.showFatal(
        "服务暂不可用",
        "暂时无法连接服务，请稍后重新打开。"
      );
      return;
    }

    this.globalData.env = getCloudEnvId();

    try {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true
      });
    } catch (error) {
      this.globalData.bootError = { type: "init", message: this.describe(error) };
      console.error("[app] wx.cloud.init failed", error);
      this.showFatal("连接失败", "暂时无法加载你的记录，请稍后重试。");
      return;
    }

    if (wx.getStorageSync(PRIVACY_CONSENT_KEY)) this.bootstrap().catch(() => {});
  },

  ensureReady() {
    if (this.globalData.appReady && this.globalData.userInfo) return Promise.resolve(this.globalData.userInfo);
    if (!wx.getStorageSync(PRIVACY_CONSENT_KEY)) {
      if (!this.openingWelcome) {
        this.openingWelcome = true;
        wx.navigateTo({url:"/pages/welcome/index",complete:()=>{this.openingWelcome=false;}});
      }
      return Promise.reject(new Error("请先完成开始使用"));
    }
    return this.bootstrap();
  },
  bootstrap() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.initializeIdentity().finally(() => {this.readyPromise=null;});
    return this.readyPromise;
  },
  async initializeIdentity() {
    try {
      const userInfo = await loginAndBootstrapUser();
      if (!userInfo || !userInfo.openId) throw new Error("未能确认账号身份，请重试");
      this.globalData.userInfo = userInfo;
      this.globalData.appReady = true;
      this.globalData.bootError = null;
      return userInfo;
    } catch (error) {
      this.globalData.appReady = false;
      console.error("[app] bootstrap failed", error);

      if (isCloudEnvError(error)) {
        this.globalData.bootError = { type: "env", message: this.describe(error) };
        this.showFatal(
          "记录暂时无法加载",
          "服务连接异常，暂时无法读取项目和报告。这不表示记录已删除，请稍后重试。"
        );
        throw error;
      }

      this.globalData.bootError = { type: "unknown", message: this.describe(error) };
      throw error;
    }
  },

  /** 把任意形态的错误整理成可读文本 */
  describe(error) {
    if (!error) {
      return "未知错误";
    }
    if (typeof error.message === "string" && error.message) {
      return error.message;
    }
    if (typeof error.errMsg === "string" && error.errMsg) {
      return error.errMsg;
    }
    return String(error);
  },

  /**
   * 阻塞式错误提示。
   * 用 showModal 而不是 showToast：toast 会自己消失，用户看不到真正的问题，
   * 这正是此前「保存项目静默失败」的成因之一。
   */
  showFatal(title, content) {
    wx.showModal({
      title,
      content,
      showCancel: false,
      confirmText: "知道了"
    });
  }
});
