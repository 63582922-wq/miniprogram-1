const { confirmInspection } = require("../../../services/inspection");
const { buildReportData, saveReport } = require("../../../services/report");
const { readDraft, patchDraft, writeDraft, finishDraft } = require("../../../utils/inspection-draft");
const { identity, bindIssues, resolveIssueMedia } = require("../../../utils/inspection-model");
const { uploadDraftMedia } = require("../../../services/inspection-media");
const { encodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");
const { toChineseSectionNumber } = require("../../../utils/format");
const { getSettings } = require("../../../services/settings");
const { getCurrentUser } = require("../../../services/user");

function buildIssueGroups(issues = [], photos = []) {
  const map = new Map();
  photos.forEach((p,i)=>map.set(p.id,{key:p.id,sourceIndex:i,image:p.annotatedImagePath||p.imagePath,caption:p.voiceText||"",issues:[]}));
  issues.forEach((item,index)=>{
    const image=(item.annotatedImages||[])[0] || (item.images||[])[0] || "";
    const key=item.sourcePhotoId || image || "legacy-"+(item.sourceIndex ?? index);
    if(!map.has(key))map.set(key,{key,sourceIndex:item.sourceIndex??index,image,issues:[]});
    map.get(key).issues.push({...item,originalIndex:index});
  });
  return [...map.values()].sort((a,b)=>a.sourceIndex-b.sourceIndex).map((g,i)=>({
    ...g,
    displayTitle:(g.issues.length ? "问题 " : "现场照片 ")+toChineseSectionNumber(i+1)
  }));
}
Page({
  async onShow(){
    try{const [company,user]=await Promise.all([getSettings(),getCurrentUser()]);this.setData({reportIdentity:{companyName:company&&company.companyName||"",logoFileId:company&&company.logoFileId||"",inspectorName:user&&user.nickname||"",inspectorPhone:user&&user.phone||""},identityError:""});}
    catch(e){this.setData({identityError:"报告资料暂未加载，可重试或前往我的资料查看"});}
  },
  editReportIdentity(){wx.navigateTo({url:"/pages/settings/index"});},
  data:{summaryEdited:false,summaryEditing:false,captionEditingIndex:-1,draftKey:"",sessionKey:"",returnContext:null,form:null,originalIssues:[],issues:[],issueGroups:[],summary:{},submitting:false,submissionLocked:false},
  onLoad(query) {
    const key=query.sessionKey || query.draftKey, draft=readDraft(key);
    if(!draft.form){wx.showModal({title:"记录不存在",content:"请返回现场记录恢复草稿",showCancel:false});return;}
    const form=draft.form, analysis=draft.analysis || {};
    const issues=bindIssues(draft.review ? draft.review.items : (analysis.items || []),form.issueDrafts || []);
    this.setData({summaryEdited:!!draft.review?.summaryEdited,submissionLocked:!!draft.submission?.requestId,draftKey:key,sessionKey:draft.sessionId || draft.sessionKey || key,returnContext:draft.returnContext || null,form,
      originalIssues:draft.review ? draft.review.originalItems : JSON.parse(JSON.stringify(issues)),issues,
      issueGroups:buildIssueGroups(issues,form.issueDrafts),
      summary:{projectName:form.projectName||"未命名项目",title:form.title||"本次巡查",contextNote:form.note||"",aiSummary:draft.review?.summary || `本次记录 ${(form.issueDrafts||[]).length} 张照片，确认 ${issues.length} 条问题。`,issueCount:issues.length,aiMode:analysis.aiMode||"",memoryHint:analysis.memoryHint||"",memoryAlerts:analysis.memoryAlerts||[]}});
    this.persistReview();
  },
  onHide(){if(!this.published)this.persistReview();},
  onUnload(){if(!this.published)this.persistReview();},
  persistReview(){
    if(!this.data.form || !this.data.sessionKey)return false;
    try {
      writeDraft(this.data.sessionKey,this.data.form,this.data.returnContext);
      patchDraft(this.data.sessionKey,{phase:this.data.submitting?"submitting":"review",review:{items:this.data.issues,originalItems:this.data.originalIssues,summary:this.data.summary.aiSummary,summaryEdited:this.data.summaryEdited}});
      return true;
    }catch(e){wx.showModal({title:"草稿保存失败",content:e.message||"请勿关闭，释放存储后重试",showCancel:false});return false;}
  },
  handleBackTap(){if(!this.persistReview())return;wx.navigateBack({delta:1,fail:()=>returnToContext(this.data.returnContext)});},
  handleHomeTap(){if(this.persistReview())wx.switchTab({url:"/pages/project/list/index"});},
  toggleSummaryEditing(){
    if(this.data.submissionLocked)return;
    const closing=this.data.summaryEditing;
    this.setData({summaryEditing:!closing});
    if(closing)this.persistReview();
  },
  toggleCaptionEditing(e){
    if(this.data.submissionLocked)return;
    const index=Number(e.currentTarget.dataset.index), closing=this.data.captionEditingIndex===index;
    this.setData({captionEditingIndex:closing?-1:index});
    if(closing)this.persistReview();
  },
  handleCaptionInput(e){if(this.data.submissionLocked)return;const index=Number(e.currentTarget.dataset.index);if(!this.data.form.issueDrafts[index])return;this.setData({[`form.issueDrafts.${index}.voiceText`]:e.detail.value});this.setData({issueGroups:buildIssueGroups(this.data.issues,this.data.form.issueDrafts)});this.persistReview();},
  handleSummaryInput(e){if(this.data.submissionLocked)return;this.setData({"summary.aiSummary":e.detail.value,summaryEdited:true});this.persistReview();},
  updateIssues(issues){if(!this.data.summaryEdited)this.setData({"summary.aiSummary":`本次记录 ${this.data.form.issueDrafts.length} 张照片，确认 ${issues.length} 条问题。`});this.setData({issues,issueGroups:buildIssueGroups(issues,this.data.form.issueDrafts),"summary.issueCount":issues.length});this.persistReview();},
  handleItemChange(event){
    if(this.data.submissionLocked){wx.showToast({title:"请继续完成同一次提交",icon:"none"});return;}
    const {index,field,value}=event.detail;
    if(!["description","suggestion","severity","responsibleParty","category","area"].includes(field)||!this.data.issues[index])return;
    this.updateIssues(this.data.issues.map((p,i)=>i===index?{...p,[field]:value}:p));
  },
  handleAddIssue(event){
    if(this.data.submissionLocked)return;
    const photos=this.data.form.issueDrafts || [], index=Number(event.currentTarget.dataset.index || 0),p=photos[index];
    if(p)this.updateIssues(this.data.issues.concat({id:identity("issue"),sourcePhotoId:p.id,sourceIndex:index,description:"",suggestion:"",severity:"normal",responsibleParty:"pending"}));
  },
  handleDeleteIssue(event){
    if(this.data.submissionLocked)return;
    const index=Number(event.currentTarget.dataset.index),target=this.data.issues[index];if(!target)return;
    wx.showModal({title:"删除这条问题？",content:"照片仍保留为现场记录。",confirmText:"删除",confirmColor:"#C13D2A",success:r=>{
      if(r.confirm)this.updateIssues(this.data.issues.filter((_,i)=>i!==index));
    }});
  },
  handleAcceptAllAndSubmit(){return this.handleSubmit();},
  async handleSubmit(){
    if(this.data.submitting || !this.data.form)return;
    if(this.data.issues.some(i=>!(i.description||"").trim())){wx.showToast({title:"请填写问题描述，或删除空白问题",icon:"none"});return;}
    if(!this.persistReview())return;
    this.setData({submitting:true});wx.showLoading({title:"保存记录",mask:true});
    try{
      const form=await uploadDraftMedia(this.data.form,async form=>{this.setData({form});if(!this.persistReview())throw new Error("草稿保存失败");});
      this.setData({form});if(!this.persistReview())throw new Error("草稿保存失败");
      const draft=readDraft(this.data.sessionKey),requestId=draft.submission?.requestId || identity("submit");
      patchDraft(this.data.sessionKey,{submission:{...draft.submission,requestId},phase:"submitting"});
      this.setData({submissionLocked:true});
      const result=draft.submission?.inspectionId?{inspectionId:draft.submission.inspectionId}:await confirmInspection({requestId,form:{...form,aiSummary:this.data.summary.aiSummary},items:resolveIssueMedia(this.data.issues,form.issueDrafts),originalItems:this.data.originalIssues});
      patchDraft(this.data.sessionKey,{submission:{requestId,inspectionId:result.inspectionId},phase:"submitting"});
      const reportData=await buildReportData({inspectionId:result.inspectionId});
      const report=await saveReport({...reportData,requestId:"report-"+result.inspectionId,status:"published"});
      if(!report || !report._id)throw new Error("报告保存未确认，请重试；巡查不会重复创建");
      markGuideStep("inspectionSubmitted",true);this.published=true;finishDraft(this.data.sessionKey);
      if(this.data.draftKey!==this.data.sessionKey)wx.removeStorageSync(this.data.draftKey);
      const context=encodeReturnContext(this.data.returnContext);
      wx.redirectTo({url:"/pages/report/detail/index?reportId="+report._id+(context?"&returnContext="+context:"")});
    }catch(e){wx.showModal({title:"尚未完成交付",content:(e.message||"请检查网络")+"\n输入已保留，重试继续同一份记录。",showCancel:false});}
    finally{wx.hideLoading();this.setData({submitting:false});}
  }
});
