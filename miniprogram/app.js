const { loginAndBootstrapUser } = require("./services/user");
const { setupPrivacyListener } = require("./utils/privacy");
const {
  getCloudEnvId,
  isCloudEnvConfigured,
  isCloudEnvError
} = require("./config/env");

const ENV_HELP_LINES = [
  "排查步骤：",
  "1. 打开微信开发者工具，进入「云开发」控制台；",
  "2. 确认环境是否存在、是否已过期；",
  "3. 复制环境 ID，填入 miniprogram/config/env.js 的 CLOUD_ENV_ID。"
].join("\n");

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
        "基础库版本过低",
        "请使用 2.2.3 或以上基础库以启用云能力。"
      );
      return;
    }

    if (!isCloudEnvConfigured()) {
      this.showFatal(
        "尚未配置云环境",
        `缺少云环境 ID，无法连接后端。\n\n${ENV_HELP_LINES}`
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
      this.showFatal("云环境初始化失败", this.describe(error).slice(0, 200));
      return;
    }

    if (wx.getStorageSync("welcomeAcceptedV1")) this.bootstrap().catch(() => {});
  },

  ensureReady() {
    if (this.globalData.appReady && this.globalData.userInfo) return Promise.resolve(this.globalData.userInfo);
    if (!wx.getStorageSync("welcomeAcceptedV1")) {
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
          "云环境不可用",
          [
            `当前环境：${this.globalData.env}`,
            "",
            "该环境可能已过期或被删除，所以所有数据都读不到。",
            "此时页面上的「暂无项目」「暂无报告」都不代表真的没有数据。",
            "",
            ENV_HELP_LINES
          ].join("\n")
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
