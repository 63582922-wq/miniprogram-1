/**
 * 窗口信息读取。
 *
 * 统一走 wx.getWindowInfo()：它是同步的，且是官方指定的窗口信息入口。
 *
 * 不用旧的 getSystemInfo 系列 —— 它自基础库 2.20.1 起已废弃、调用开销也大，
 * 而且只要代码里出现这个 API 名，开发者工具就会报「getSystemInfo API 提示」。
 * 本项目基础库为 3.x，wx.getWindowInfo 一定可用，因此不保留回退分支。
 *
 * 只取窗口相关字段（statusBarHeight / windowHeight 等）。
 * 设备信息请用 wx.getDeviceInfo()，不要从这里拿。
 */
function getWindowInfo() {
  if (typeof wx.getWindowInfo !== "function") {
    console.warn("[system] 当前基础库不支持 wx.getWindowInfo，请升级调试基础库");
    return {};
  }
  return wx.getWindowInfo();
}

module.exports = {
  getWindowInfo
};
