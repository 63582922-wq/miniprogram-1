Page({
  data:{agreed:false,loading:false,error:""},
  handleAgreeChange(event){this.setData({agreed:(event.detail.value||[]).includes("agreed")});},
  openLegal(){wx.navigateTo({url:"/pages/legal/index"});},
  async start(){
    if (this.data.loading) return;
    if (!this.data.agreed) {this.setData({error:"请先阅读并同意隐私与服务说明"});return;}
    this.setData({loading:true,error:""});
    try {
      await getApp().bootstrap();
      wx.setStorageSync("welcomeAcceptedV1", true);
      wx.switchTab({url:"/pages/project/list/index"});
    } catch(e) {this.setData({error:e.message||"身份初始化失败，请重试"});}
    finally {this.setData({loading:false});}
  }
});
