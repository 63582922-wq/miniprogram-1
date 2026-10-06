const { submitPrivacyRequest, listPrivacyRequests } = require("../../services/user");
const { identity } = require("../../utils/inspection-model");

Page({
  data:{requestTypes:["查阅/复制","更正","删除个人信息","注销账号","撤回同意","其他"],requestTypeIndex:0,requestDetails:"",requestMessage:"",submitting:false,requests:[]},
  onShow(){this.loadRequests();},
  handleRequestTypeChange(e){this.setData({requestTypeIndex:Number(e.detail.value)||0,requestMessage:""});},
  handleRequestDetailsInput(e){this.setData({requestDetails:e.detail.value||""});},
  async loadRequests(){
    try{
      const rows=await listPrivacyRequests();
      const statusText={received:"已受理，待核验",processing:"处理中",completed:"已处理",rejected:"无法按申请处理"};
      this.setData({requests:(Array.isArray(rows)?rows:[]).map(row=>({...row,statusText:statusText[row.status]||"待运营者确认",dateText:row.createdAt?new Date(row.createdAt).toLocaleDateString():""}))});
    }catch(_error){/* 未同意或暂时离线时，不阻断阅读隐私说明 */}
  },
  async submitRequest(){
    if(this.data.submitting||this.privacyRequestSubmitting)return;
    this.privacyRequestSubmitting=true;
    this.setData({submitting:true,requestMessage:""});
    try{
      this.privacyRequestId=this.privacyRequestId||identity("privacy");
      const result=await submitPrivacyRequest({requestId:this.privacyRequestId,requestType:this.data.requestTypes[this.data.requestTypeIndex],details:this.data.requestDetails});
      this.privacyRequestId="";
      this.setData({requestDetails:"",requestMessage:"申请已提交，尚未完成处理。请稍后查看状态；涉及分享报告的处理不会自动撤销分享链接。"});
      await this.loadRequests();
      return result;
    }catch(error){this.setData({requestMessage:error.message||"提交失败，请稍后重试"});}
    finally{this.privacyRequestSubmitting=false;this.setData({submitting:false});}
  },
  handleBackTap() {
    wx.navigateBack({
      delta: 1
    });
  }
});
