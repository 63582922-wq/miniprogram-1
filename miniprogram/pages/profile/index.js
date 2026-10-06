const { getCurrentUser } = require("../../services/user");
const { getSettings } = require("../../services/settings");
const { resolveCloudFileUrls, isCloudFileId } = require("../../services/cloud-media");
const { syncTabBar } = require("../../utils/tab-bar");
const { getInspectorName } = require("../../utils/report-identity");

async function resolveLogoPreview(fileId) {
  if (!fileId) return { url: "", error: false };
  if (!isCloudFileId(fileId)) return { url: fileId, error: false };
  const result = await resolveCloudFileUrls([fileId]);
  return {url:result.urls[fileId] || "",error:result.failed.includes(fileId)};
}

Page({
  data:{loading:true,loadError:"",displayUserInfo:{},company:{},contactLine:"添加巡查联系电话",completionText:"",identity:{completeCount:0,hasCompany:false,hasLogo:false,hasInspector:false,hasPhone:false}},
  onShow(){syncTabBar(this,"pages/profile/index");this.loadUser();},
  async loadUser(){
    const generation = (this.profileLoadGeneration || 0) + 1;
    this.profileLoadGeneration = generation;
    this.setData({loading:true,loadError:""});
    try {
      const [user, company] = await Promise.all([getCurrentUser(),getSettings()]);
      if (generation !== this.profileLoadGeneration) return;
      if(!user || !user.openId) throw new Error("身份尚未就绪，请重试");
      const identity = {
        hasCompany: Boolean(company && company.companyName),
        hasLogo: Boolean(company && company.logoFileId),
        hasInspector: Boolean(getInspectorName(user)),
        hasPhone: Boolean((user && user.phone) || (company && company.companyPhone))
      };
      identity.completeCount = [identity.hasCompany, identity.hasLogo, identity.hasInspector, identity.hasPhone].filter(Boolean).length;
      const complete = identity.completeCount === 4;
      const inspectorPhone = (user && user.phone) || "";
      const companyPhone = (company && company.companyPhone) || "";
      const savedCompany = company || {};
      this.setData({displayUserInfo:{...user,nickname:getInspectorName(user)},company:{...savedCompany,logoPreviewUrl:"",logoPreviewError:false},contactLine:inspectorPhone?`巡查联系电话 · ${inspectorPhone}`:companyPhone?`公司联系电话 · ${companyPhone}`:"添加巡查联系电话",identity,completionText:complete?"报告资料已填写":"完善资料，让接收人知道是谁检查、如何联系"});
      if (savedCompany.logoFileId) {
        const preview = await resolveLogoPreview(savedCompany.logoFileId);
        if (generation === this.profileLoadGeneration && this.data.company.logoFileId === savedCompany.logoFileId) {
          this.setData({"company.logoPreviewUrl":preview.url,"company.logoPreviewError":preview.error});
        }
      }
    }catch(e){if(generation===this.profileLoadGeneration)this.setData({loadError:e.message||"资料加载失败"});}
    finally{if(generation===this.profileLoadGeneration)this.setData({loading:false});}
  },
  handleLogoPreviewError(){this.setData({"company.logoPreviewUrl":"","company.logoPreviewError":true});},
  goSettings(e){const section=e && e.currentTarget.dataset.section || "";wx.navigateTo({url:"/pages/settings/index?section="+section});},
  openLegal(){wx.navigateTo({url:"/pages/legal/index"});},
  openGuide(){wx.navigateTo({url:"/pages/onboarding/index?source=profile"});}
});
