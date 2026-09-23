const {readDraft,updateIssueDraft}=require("../../../utils/inspection-draft");
const {keepLocalFile}=require("../../../services/inspection-media");
Page({
 data:{sessionKey:"",issueId:"",imagePath:"",annotations:[],annotationStage:null,saving:false,editorReady:false,editorError:"",storageError:""},
 onLoad(q){this.setData({sessionKey:q.sessionKey||"",issueId:decodeURIComponent(q.issueId||"")});const {form}=readDraft(this.data.sessionKey);const p=(form?.issueDrafts||[]).find(p=>p.id===this.data.issueId);
 if(!p){wx.showModal({title:"照片草稿不存在",content:"请返回现场记录",showCancel:false});return;}
 this.setData({imagePath:p.localImagePath||p.imagePath,annotations:p.annotations||[],annotationStage:p.annotationStage||null});},
 handleAnnotationChange(e){this.setData({annotations:e.detail});this.saveGeometry();},
 handleStageChange(e){this.setData({annotationStage:e.detail});this.saveGeometry();},
 handleEditorReady(){this.setData({editorReady:true,editorError:""});},
 handleEditorError(e){this.setData({editorReady:false,editorError:e.detail?.message||"照片加载失败，请返回重试"});},
 handleNormalized(e){const {path,originalPath}=e.detail;const draft=readDraft(this.data.sessionKey);const p=(draft.form?.issueDrafts||[]).find(p=>p.id===this.data.issueId);
  this.normalizedPhoto={imagePath:path,localImagePath:path,sourceOriginalImagePath:p?.sourceOriginalImagePath||originalPath,orientationNormalized:true};this.saveGeometry();},
 saveGeometry(){try{const form=updateIssueDraft(this.data.sessionKey,this.data.issueId,{...this.normalizedPhoto,annotations:this.data.annotations,annotationCount:this.data.annotations.length,annotationStage:this.data.annotationStage,annotationDirty:true});if(!form)throw new Error("草稿已失效");this.setData({storageError:""});return true;}catch(e){this.setData({storageError:"标注未能暂存，请勿关闭。释放存储空间后点击保存重试。"});return false;}},
 handleBackTap(){wx.showModal({title:"返回现场记录",content:"标注形状已暂存，保存后才更新报告预览。",confirmText:"保存返回",cancelText:"继续编辑",success:r=>{if(r.confirm)this.handleSave();}});},
 async handleSave(){if(this.data.saving)return;if(!this.data.editorReady){wx.showToast({title:this.data.editorError||"照片还在加载，请稍候",icon:"none"});return;}this.setData({saving:true});try{
 const editor=this.selectComponent("#annotationEditor");const path=await editor.exportImage();const saved=await keepLocalFile(path);
 const form=updateIssueDraft(this.data.sessionKey,this.data.issueId,{...this.normalizedPhoto,annotations:this.data.annotations,annotationCount:this.data.annotations.length,annotationStage:this.data.annotationStage,annotatedImagePath:saved,annotationDirty:false});
 if(!form)throw new Error("草稿已失效，不能保存");wx.navigateBack();
 }catch(e){wx.showModal({title:"标注未保存",content:e.message||"图片导出失败，请重试",showCancel:false});}finally{this.setData({saving:false});}}
});
