/**
 * 窗口信息读取。
 *
 * wx.getSystemInfoSync 自基础库 2.20.1 起已废弃，官方替代是同步的
 * wx.getWindowInfo()。直接换新接口在低版本基础库上会报错，所以这里做一层兼容。
 *
 * 只取窗口相关字段（statusBarHeight / windowHeight 等）；
 * 设备信息请用 wx.getDeviceInfo()，不要从这里拿。
 */
function getWindowInfo() {
  if (typeof wx.getWindowInfo === "function") {
    try {
      return wx.getWindowInfo();
    } catch (error) {
      console.warn("[system] wx.getWindowInfo 失败，回退到 wx.getSystemInfoSync", error);
    }
  }

  if (typeof wx.getSystemInfoSync === "function") {
    return wx.getSystemInfoSync();
  }

  return {};
}

module.exports = {
  getWindowInfo
};
