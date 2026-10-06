const {readDraft,updateIssueDraft}=require("../../../utils/inspection-draft");
const {keepLocalFile}=require("../../../services/inspection-media");
const {isCloudFileId,resolveCloudFileUrls}=require("../../../services/cloud-media");
Page({
 data:{sessionKey:"",issueId:"",imagePath:"",annotations:[],annotationStage:null,hasPendingEdits:false,leaveDialogOpen:false,saving:false,editorReady:false,editorError:"",storageError:""},
 async onLoad(q){this.setData({sessionKey:q.sessionKey||"",issueId:decodeURIComponent(q.issueId||"")});const {form}=readDraft(this.data.sessionKey);const p=(form?.issueDrafts||[]).find(p=>p.id===this.data.issueId);
 if(!p){wx.showModal({title:"照片草稿不存在",content:"请返回现场记录",showCancel:false});return;}
 this.initialAnnotation={annotations:p.annotations||[],annotationCount:(p.annotations||[]).length,annotationStage:p.annotationStage||null,annotatedImagePath:p.annotatedImagePath||"",localAnnotatedImagePath:p.localAnnotatedImagePath||"",annotationRevision:p.annotationRevision||0};
 const stablePath=p.localImagePath||p.imagePath||"";
 this.setData({imagePath:isCloudFileId(stablePath)?"":stablePath,annotations:p.annotations||[],annotationStage:p.annotationStage||null,hasPendingEdits:!!p.annotationDirty});
 if(isCloudFileId(stablePath)){
  try{
   const result=await resolveCloudFileUrls([stablePath]);
   if(this.data.sessionKey!==q.sessionKey||this.data.issueId!==decodeURIComponent(q.issueId||""))return;
   const displayPath=result.urls[stablePath]||"";
   if(!displayPath)throw new Error("照片预览地址获取失败");
   this.setData({imagePath:displayPath});
  }catch(e){this.setData({editorError:"照片暂时无法加载，请返回现场记录重试"});}
 }
 },
 handleAnnotationChange(e){this.setData({annotations:e.detail,hasPendingEdits:true});this.saveGeometry();},
 handleStageChange(e){this.setData({annotationStage:e.detail,hasPendingEdits:true});this.saveGeometry();},
 handleEditorReady(e){const detail=e.detail||{};this.setData({editorReady:true,editorError:"",annotations:Array.isArray(detail.annotations)?detail.annotations:this.data.annotations,annotationStage:detail.stage||this.data.annotationStage});},
 handleEditorError(e){this.setData({editorReady:false,editorError:e.detail?.message||"照片加载失败，请返回重试"});},
 handleNormalized(e){const {path,originalPath}=e.detail;const draft=readDraft(this.data.sessionKey);const p=(draft.form?.issueDrafts||[]).find(p=>p.id===this.data.issueId);
  this.normalizedPhoto={imagePath:path,localImagePath:path,sourceOriginalImagePath:p?.sourceOriginalImagePath||originalPath,orientationNormalized:true};
  try{if(!updateIssueDraft(this.data.sessionKey,this.data.issueId,this.normalizedPhoto))throw new Error("草稿已失效");this.setData({storageError:""});}
  catch(_error){this.setData({storageError:"照片方向校正未能暂存，请勿关闭。释放存储空间后返回重试。"});}},
 saveGeometry(){try{const form=updateIssueDraft(this.data.sessionKey,this.data.issueId,{...this.normalizedPhoto,annotations:this.data.annotations,annotationCount:this.data.annotations.length,annotationStage:this.data.annotationStage,annotationDirty:true});if(!form)throw new Error("草稿已失效");this.setData({storageError:""});return true;}catch(e){this.setData({storageError:"标注未能暂存，请勿关闭。释放存储空间后点击保存重试。"});return false;}},
 handleBackTap(){if(!this.data.hasPendingEdits){wx.navigateBack();return;}this.setData({leaveDialogOpen:true});},
 closeLeaveDialog(){this.setData({leaveDialogOpen:false});},
 ignoreLeaveDialogTap(){},
 saveAndReturn(){if(this.data.saving)return;this.setData({leaveDialogOpen:false});this.handleSave();},
 cancelEditsAndReturn(){const original=this.initialAnnotation||{annotations:[],annotationCount:0,annotationStage:null,annotatedImagePath:"",localAnnotatedImagePath:"",annotationRevision:0};const form=updateIssueDraft(this.data.sessionKey,this.data.issueId,{...this.normalizedPhoto,...original,annotationDirty:false});if(!form){this.setData({leaveDialogOpen:false,storageError:"照片草稿已失效，无法取消本次编辑。请返回现场记录重新打开。"});return;}wx.navigateBack();},
 async handleSave(){if(this.data.saving)return;if(!this.data.editorReady){wx.showToast({title:this.data.editorError||"照片还在加载，请稍候",icon:"none"});return;}this.setData({saving:true});try{
 const editor=this.selectComponent("#annotationEditor");const path=await editor.exportImage();const saved=await keepLocalFile(path);
 const latest=readDraft(this.data.sessionKey),photo=(latest.form?.issueDrafts||[]).find(item=>item.id===this.data.issueId);
 const form=updateIssueDraft(this.data.sessionKey,this.data.issueId,{...this.normalizedPhoto,annotations:this.data.annotations,annotationCount:this.data.annotations.length,annotationStage:this.data.annotationStage,annotatedImagePath:saved,annotationRevision:(photo?.annotationRevision||0)+1,annotationDirty:false});
 if(!form)throw new Error("草稿已失效，不能保存");this.setData({storageError:""});wx.navigateBack();
 }catch(_error){this.setData({storageError:"保存标注失败，内容仍保留在本机。请检查存储空间后重试。"});}finally{this.setData({saving:false});}}
});
