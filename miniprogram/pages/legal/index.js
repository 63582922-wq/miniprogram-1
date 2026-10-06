const { submitPrivacyRequest, listPrivacyRequests } = require("../../services/user");
const { identity } = require("../../utils/inspection-model");

Page({
  data:{requestTypes:["查阅/复制","更正","删除个人信息","注销账号","撤回同意","其他"],requestTypeIndex:0,requestDetails:"",requestMessage:"",submitting:false,requests:[],requestsLoaded:false},
  onShow(){this.loadRequests();},
  handleRequestTypeChange(e){this.setData({requestTypeIndex:Number(e.detail.value)||0,requestMessage:""});},
  handleRequestDetailsInput(e){this.setData({requestDetails:e.detail.value||""});},
  async loadRequests(){
    try{
      const rows=await listPrivacyRequests();
      const statusText={received:"已受理，待核验",processing:"处理中",completed:"已处理",rejected:"无法按申请处理"};
      this.setData({requestsLoaded:true,requests:(Array.isArray(rows)?rows:[]).map(row=>({...row,statusText:statusText[row.status]||"待运营者确认",dateText:row.createdAt?new Date(row.createdAt).toLocaleDateString():""}))});
    }catch(error){
      // 未同意或暂时离线时，不阻断阅读隐私说明；但也不能装作「没有申请」——
      // 申请记录读不到必须让用户看得出来，否则会以为自己的申请丢了。
      console.warn("[legal] 申请状态读取失败", error && error.message);
      this.setData({requestsLoaded:false});
    }
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
    }catch(error){
      // 云的原始报错（-502005 之类）对用户没有任何意义，不能直接甩在页面上。
      // 详情进日志供排查，页面只给一句人能读的话，并给出可执行的下一步。
      console.error("[legal] 提交申请失败", error && error.message);
      this.setData({requestMessage:"申请没有提交成功，请检查网络后重试。若持续失败，请通过小程序内的联系方式直接联系我们，不要重复提交。"});
    }
    finally{this.privacyRequestSubmitting=false;this.setData({submitting:false});}
  },
  handleBackTap() {
    wx.navigateBack({
      delta: 1
    });
  }
});
