const { getProjectDetail, saveProject } = require("../../../services/project");
const { PROJECT_STATUS_OPTIONS } = require("../../../constants/status");
const { markGuideStep } = require("../../../utils/guide");
const { identity } = require("../../../utils/inspection-model");
const KEY="projectCreateDraftV2";
Page({
  data:{projectId:"",pageTitle:"新建项目",isSaving:false,submissionLocked:false,showOptional:false,
    projectStatusOptions:PROJECT_STATUS_OPTIONS,projectStatusIndex:0,
    form:{name:"",address:"",clientName:"",clientPhone:"",description:"",status:"active"}},
  async onLoad(query){
    this.loadFailed=true;
    try {await getApp().ensureReady();this.draftKey=KEY+":"+getApp().globalData.userInfo.openId;}
    catch(e){wx.showToast({title:e.message,icon:"none"});return;}
    this.loadFailed=false;
    this.requestId=identity("project");
    if(query.projectId){
      this.setData({projectId:query.projectId,pageTitle:"编辑项目"});
      try{const r=await getProjectDetail(query.projectId);const p=r.project;
        this.setData({form:{name:p.name||"",address:p.address||"",clientName:p.clientName||"",clientPhone:p.clientPhone||"",description:p.description||"",status:p.status||"active"},
          projectStatusIndex:Math.max(0,PROJECT_STATUS_OPTIONS.findIndex(x=>x.value===p.status))});
      }catch(e){this.loadFailed=true;wx.showModal({title:"项目加载失败",content:e.message||"请返回重试",showCancel:false});}
    }else{
      let d=wx.getStorageSync(this.draftKey);
      if(!d){
        const legacy=wx.getStorageSync(KEY);
        if(legacy&&legacy.form){
          const choice=await new Promise(resolve=>wx.showModal({title:"恢复旧版项目草稿？",content:"本机有尚未完成的新建项目。确认属于你的记录后可继续；原草稿不会被删除。",confirmText:"恢复草稿",cancelText:"新建项目",success:resolve,fail:()=>resolve({confirm:false})}));
          if(choice.confirm){d=legacy;wx.setStorageSync(this.draftKey,legacy);}
        }
      }
      if(d && d.form){this.requestId=d.requestId;this.setData({form:d.form,submissionLocked:!!d.submitted});}
    }
  },
  onHide(){this.saveDraft();},
  onUnload(){this.saveDraft();},
  saveDraft(){
    if(this.data.projectId || this.saved || !this.draftKey)return true;
    try{wx.setStorageSync(this.draftKey,{requestId:this.requestId,form:this.data.form,submitted:this.data.submissionLocked});return true;}
    catch(e){wx.showModal({title:"草稿保存失败",content:"请释放本机空间后重试，请勿关闭。",showCancel:false});return false;}
  },
  toggleOptional(){this.setData({showOptional:!this.data.showOptional});},
  handleInput(e){if(this.data.submissionLocked)return;const field=e.currentTarget.dataset.field;
    if(!["name","address","clientName","clientPhone","description"].includes(field))return;
    this.setData({["form."+field]:e.detail.value});this.saveDraft();
  },
  handleProjectStatusChange(e){if(this.data.submissionLocked)return;const i=Number(e.detail.value);
    this.setData({projectStatusIndex:i,"form.status":PROJECT_STATUS_OPTIONS[i].value});this.saveDraft();
  },
  async handleSubmit(){
    if(this.data.isSaving || this.loadFailed)return;
    if(!this.data.form.name.trim()){wx.showToast({title:"请填写项目名称",icon:"none"});return;}
    if(!this.data.projectId){this.setData({submissionLocked:true});if(!this.saveDraft())return;}
    this.setData({isSaving:true});
    try{
      const saved=await saveProject({...this.data.form,requestId:this.requestId,projectId:this.data.projectId});
      const savedId = saved && (saved._id || (saved.project && saved.project._id));
      if (!savedId || (this.data.projectId && savedId !== this.data.projectId)) {
        throw new Error("服务端未返回可确认的项目编号，请重试恢复本次保存");
      }
      this.saved=true;if(!this.data.projectId)wx.removeStorageSync(this.draftKey);
      markGuideStep("projectCreated",true);
      wx.redirectTo({url:"/pages/project/detail/index?projectId="+encodeURIComponent(savedId)});
    }catch(e){wx.showModal({title:"保存尚未确认",content:(e.message||"网络异常")+"。重试将继续同一次保存，不会重复创建。",showCancel:false});}
    finally{this.setData({isSaving:false});}
  }
});
