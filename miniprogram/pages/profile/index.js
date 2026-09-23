const { getCurrentUser } = require("../../services/user");
const { getSettings } = require("../../services/settings");
const { syncTabBar } = require("../../utils/tab-bar");
Page({
  data:{loading:true,loadError:"",displayUserInfo:{},company:{},completionText:"",identity:{completeCount:0,hasCompany:false,hasLogo:false,hasInspector:false,hasPhone:false}},
  onShow(){syncTabBar(this,"pages/profile/index");this.loadUser();},
  async loadUser(){
    this.setData({loading:true,loadError:""});
    try {
      const [user, company] = await Promise.all([getCurrentUser(),getSettings()]);
      if(!user || !user.openId) throw new Error("身份尚未就绪，请重试");
      const identity = {
        hasCompany: Boolean(company && company.companyName),
        hasLogo: Boolean(company && company.logoFileId),
        hasInspector: Boolean(user && user.nickname),
        hasPhone: Boolean((user && user.phone) || (company && company.companyPhone))
      };
      identity.completeCount = [identity.hasCompany, identity.hasLogo, identity.hasInspector, identity.hasPhone].filter(Boolean).length;
      const complete = identity.completeCount === 4;
      this.setData({displayUserInfo:user,company:company||{},identity,completionText:complete?"报告资料已填写":"完善资料，让接收人知道是谁检查、如何联系"});
    }catch(e){this.setData({loadError:e.message||"资料加载失败"});}
    finally{this.setData({loading:false});}
  },
  goSettings(e){const section=e && e.currentTarget.dataset.section || "";wx.navigateTo({url:"/pages/settings/index?section="+section});},
  openLegal(){wx.navigateTo({url:"/pages/legal/index"});},
  openGuide(){wx.navigateTo({url:"/pages/onboarding/index?source=profile"});}
});
