/**
 * 当前跑的是哪个版本。
 *
 * 内测期间这件事必须一眼可见：测试者反馈问题时，第一句往往是
 * 「我装的是哪一版」——如果没有地方能看到，就只能靠猜，而体验版、
 * 开发版、正式版三者的代码可能差着十几个版本。
 *
 * wx.getAccountInfoSync() 在基础库 2.2.2 起可用；拿不到时返回空字符串，
 * 界面上不显示，绝不因为一个版本号让页面报错。
 */
function getBuildInfo() {
  let envVersion = "";
  let version = "";
  try {
    const info = typeof wx !== "undefined" && typeof wx.getAccountInfoSync === "function"
      ? wx.getAccountInfoSync()
      : null;
    const miniProgram = (info && info.miniProgram) || {};
    envVersion = `${miniProgram.envVersion || ""}`;
    version = `${miniProgram.version || ""}`;
  } catch (_error) {
    return { envLabel: "", version: "", text: "" };
  }

  const envLabel = envVersion === "release" ? "正式版"
    : envVersion === "trial" ? "体验版"
      : envVersion === "develop" ? "开发版"
        : "";

  // 本地预览（IDE 直接编译）没有环境标识，也没有版本号——这时候不显示，
  // 免得出现一行「版本 」这种半截文案。
  const text = version ? `${envLabel} ${version}`.trim() : envLabel;
  return { envLabel, version, text };
}

module.exports = { getBuildInfo };
