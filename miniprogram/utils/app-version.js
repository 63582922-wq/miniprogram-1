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
let stamped = null;
function getStampedBuild() {
  if (stamped !== null) return stamped;
  try {
    // 上传时由 scripts/upload.cjs 写入；开发版里平台不给版本号，只能靠它
    stamped = require("../build-info.js") || {};
  } catch (_error) {
    stamped = {};
  }
  return stamped;
}

function getBuildInfo() {
  let envVersion = "";
  let platformVersion = "";
  try {
    const info = typeof wx !== "undefined" && typeof wx.getAccountInfoSync === "function"
      ? wx.getAccountInfoSync()
      : null;
    const miniProgram = (info && info.miniProgram) || {};
    envVersion = `${miniProgram.envVersion || ""}`;
    platformVersion = `${miniProgram.version || ""}`;
  } catch (_error) {
    // 老基础库没有这个 API，继续走下面的回退
  }

  const envLabel = envVersion === "release" ? "正式版"
    : envVersion === "trial" ? "体验版"
      : envVersion === "develop" ? "开发版"
        : "";

  // 平台给了版本号就用它（体验版/正式版）；否则回退到上传时写进代码的那份。
  // 开发版正是靠这次回退才看得到版本——否则只剩一个光秃秃的「开发版」。
  const build = getStampedBuild();
  const version = platformVersion || `${build.version || ""}`;
  const source = platformVersion ? "platform" : (version ? "stamped" : "");

  // 本地预览既没有环境标识也没有版本号时不显示，免得出现「版本 」这种半截文案。
  const text = version ? `${envLabel} ${version}`.trim() : envLabel;
  return { envLabel, version, source, text };
}

module.exports = { getBuildInfo };
