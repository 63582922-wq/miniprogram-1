const { getCurrentUser } = require("../../services/user");

Page({
  data: {
    displayUserInfo: {
      avatarUrl: "/images/avatar.png",
      nickname: "微信用户",
      phone: ""
    },
    profileSubtitle: "巡查人信息与公司信息统一在设置中维护"
  },
  onShow() {
    this.loadUser();
  },
  async loadUser() {
    try {
      const userInfo = await getCurrentUser();
      this.setData({
        displayUserInfo: {
          avatarUrl: (userInfo && userInfo.avatarUrl) || "/images/avatar.png",
          nickname: (userInfo && userInfo.nickname) || "微信用户",
          phone: (userInfo && userInfo.phone) || ""
        },
        profileSubtitle: (userInfo && userInfo.phone)
          ? `当前巡查联系电话：${userInfo.phone}`
          : "巡查人信息与公司信息统一在设置中维护"
      });
    } catch (error) {
      this.setData({
        displayUserInfo: {
          avatarUrl: "/images/avatar.png",
          nickname: "微信用户",
          phone: ""
        },
        profileSubtitle: "巡查人信息与公司信息统一在设置中维护"
      });
    }
  },
  goSettings() {
    wx.navigateTo({
      url: "/pages/settings/index"
    });
  }
});
