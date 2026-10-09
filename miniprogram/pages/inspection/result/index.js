const { confirmInspection } = require("../../../services/inspection");
const { buildReportData, saveReport } = require("../../../services/report");
const { readDraft, patchDraft, writeDraft, finishDraft } = require("../../../utils/inspection-draft");
const { identity, bindIssues, resolveIssueMedia, getPhotoDisplayPath, isNumberedAnnotation } = require("../../../utils/inspection-model");
const { uploadDraftMedia } = require("../../../services/inspection-media");
const { encodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");
const { getSettings } = require("../../../services/settings");
const { getCurrentUser } = require("../../../services/user");
const { resolveCloudFileUrls, isCloudFileId } = require("../../../services/cloud-media");
const { getInspectorName } = require("../../../utils/report-identity");
const { coachData, coachMethods } = require("../../../utils/coach-page");

function buildIssueGroups(issues = [], photos = []) {
  const map = new Map();
  const groups = [];
  photos.forEach((p,i)=>{
    const group={key:p.id||`photo-${i}`,sourceIndex:i,image:getPhotoDisplayPath(p),caption:p.caption||"",issues:[]};
    groups.push(group);
    [p.id,p.photoId,p.mediaId,p.imagePath,p.annotatedImagePath].filter(Boolean).forEach(value=>{
      if(!map.has(value))map.set(value,group);
      else if(map.get(value)!==group)map.set(value,null);
    });
    // Positional aliases are legacy fallbacks. Never overwrite a real stable
    // photo ID such as "photo-1" with an alias from a later row.
    if (!map.has(`photo-${i}`)) map.set(`photo-${i}`,group);
    if (!map.has(`source-${i}`)) map.set(`source-${i}`,group);
  });
  issues.forEach((item,index)=>{
    const image=(item.annotatedImages||[])[0] || (item.images||[])[0] || "";
    const key=item.sourcePhotoId || image || "legacy-"+(item.sourceIndex ?? index);
    const matched=map.has(key)?map.get(key):undefined;
    const group=matched===null
      ? {key:`legacy-unresolved-${index}`,sourceIndex:item.sourceIndex??index,image,issues:[],sourceAmbiguous:true}
      : (matched || {key,sourceIndex:item.sourceIndex??index,image,issues:[],sourceAmbiguous:true});
    if(!matched){map.set(group.key,group);groups.push(group);}
    group.issues.push({...item,originalIndex:index});
  });
  return groups.sort((a,b)=>a.sourceIndex-b.sourceIndex).map((g,i)=>{
    let lastDisplayNumber = 0;
    const orderedIssues = g.issues.slice().sort((left, right) => {
      const a = left.markerNumber || left.subIssueIndex || left.originalIndex || 0;
      const b = right.markerNumber || right.subIssueIndex || right.originalIndex || 0;
      return a - b;
    }).map((issue, issueIndex) => {
      const hasDescription = Boolean((issue.description || "").trim());
      const number = hasDescription ? (Number(issue.markerNumber) || (lastDisplayNumber + 1)) : 0;
      if (hasDescription) lastDisplayNumber = Math.max(lastDisplayNumber, number);
      return {
        ...issue,
        displayNo: hasDescription ? `${number}.` : "",
        reviewNumber: number,
        markerLabel: issue.markerNumber ? `照片标注 ${issue.markerNumber}` : "未标注位置"
      };
    });
    const confirmedCount = orderedIssues.filter(issue => (issue.description || "").trim()).length;
    const pendingCount = orderedIssues.length - confirmedCount;
    return {
      ...g,
      issues: orderedIssues,
      displayTitle:`照片 ${String(i + 1).padStart(2, "0")}${g.sourceAmbiguous ? " · 来源待确认" : ""}`,
      statusText:confirmedCount ? `${confirmedCount} 项问题${pendingCount ? ` · ${pendingCount} 条待补充` : ""}` : (pendingCount ? `${pendingCount} 条待补充` : "未记录问题"),
      mappingText:g.issues.length && orderedIssues.every(issue => Number(issue.markerNumber) > 0)
        ? "照片标注号与下方同号问题一一对应"
        : "问题按本照片内顺序编号；未标注位置的问题没有照片编号"
    };
  });
}
Page({
  async onShow(){
    this.syncCoach();
    const generation=(this.identityLoadGeneration||0)+1;
    this.identityLoadGeneration=generation;
    try{
      const [company,user]=await Promise.all([getSettings(),getCurrentUser()]);
      const logoFileId=company&&company.logoFileId||"";
      if(generation!==this.identityLoadGeneration)return;
      this.setData({reportIdentity:{companyName:company&&company.companyName||"",companyPhone:company&&company.companyPhone||"",companyAddress:company&&company.companyAddress||"",logoFileId,logoPreviewUrl:isCloudFileId(logoFileId)?"":logoFileId,inspectorName:getInspectorName(user),inspectorPhone:user&&user.phone||""},identityError:"",identityLogoError:false});
      if(isCloudFileId(logoFileId)){
        const result=await resolveCloudFileUrls([logoFileId]);
        if(generation===this.identityLoadGeneration&&this.data.reportIdentity.logoFileId===logoFileId){
          this.setData({"reportIdentity.logoPreviewUrl":result.urls[logoFileId]||"",identityLogoError:result.failed.includes(logoFileId)});
        }
      }
    }
    catch(e){if(generation===this.identityLoadGeneration)this.setData({identityError:"报告资料暂未加载，可重试或前往我的资料查看"});}
  },
  retryIdentityLoad(){return this.onShow();},
  acceptObservation(event){
    if(this.data.submissionLocked)return;
    const id=event.currentTarget.dataset.photoId;
    const group=this.data.issueGroups.find(group=>group.key===id);
    if(!group || !group.aiObservations?.length)return;
    const caption=group.aiObservations.join('；');
    const apply=()=>{
      this.setData({form:{...this.data.form,issueDrafts:this.data.form.issueDrafts.map(photo=>photo.id===id?{...photo,caption}:photo)},issueGroups:this.data.issueGroups.map(row=>row.key===id?{...row,caption}:row)});
      this.persistReview();
    };
    if(group.caption)wx.showModal({title:'更新照片说明？',content:'将替换当前照片说明，不会新增质量问题。',success:result=>{if(result.confirm)apply();}});
    else apply();
  },
  handleIdentityLogoError(){this.setData({"reportIdentity.logoPreviewUrl":"",identityLogoError:true});},
  editReportIdentity(){wx.navigateTo({url:"/pages/settings/index"});},
  data:{...coachData(),summaryEdited:false,reviewNeedsAttention:false,reviewStalePhotoIds:[],draftKey:"",sessionKey:"",returnContext:null,form:null,reportIdentity:{companyName:"",companyPhone:"",companyAddress:"",logoFileId:"",logoPreviewUrl:"",inspectorName:"",inspectorPhone:""},identityError:"",identityLogoError:false,mediaLoadError:"",mediaLoadGeneration:0,originalIssues:[],issues:[],issueGroups:[],summary:{},submitting:false,submissionLocked:false},
  onLoad(query) {
    const key=query.sessionKey || query.draftKey, draft=readDraft(key);
    if(!draft.form){wx.showModal({title:"记录不存在",content:"请返回现场记录恢复草稿",showCancel:false});return;}
    const form=draft.form, analysis=draft.analysis || {};
    const photos=form.issueDrafts||[];
    // Treat the persisted per-photo choice as authoritative. Older deployed
    // AI functions may omit `aiMode` from a successful response; that must not
    // make an explicitly requested, empty AI result disappear from review.
    const visionRequested=photos.some(photo=>photo.analysisMode==='ai'||photo.analysisModeResolved==='ai'||
      (!!photo.imagePath&&!['manual','pending'].includes(photo.analysisMode)&&!`${photo.voiceText||''}`.trim())
    );
    const aiRequested=visionRequested;
    const textOrganizationRequested=photos.some(photo=>photo.organizeText===true&&photo.analysisMode!=='ai');
    const issues=bindIssues(draft.review ? draft.review.items : (analysis.items || []),photos);
    const summaryEdited=!!draft.review?.summaryEdited;
    const reviewNeedsAttention=!!draft.review?.stale;
    const savedSummary=summaryEdited ? (draft.review?.summary || "") : "";
    const observationByPhoto=new Map();
    (analysis.observations||[]).forEach(item=>{
      const photoId=item.sourcePhotoId||(photos[item.sourceIndex]?.id);
      const text=`${item.text||''}`.trim();
      if(!photoId||!text)return;
      observationByPhoto.set(photoId,[...(observationByPhoto.get(photoId)||[]),text]);
    });
    const aiOutputPhotoIds=new Set();
    (analysis.observations||[]).forEach(item=>{
      const photoId=item.sourcePhotoId||(photos[item.sourceIndex]?.id);
      if(photoId&&`${item.text||''}`.trim())aiOutputPhotoIds.add(photoId);
    });
    (analysis.items||[]).forEach(item=>{
      const photoId=item.sourcePhotoId||(photos[item.sourceIndex]?.id);
      if(photoId&&`${item.description||''}`.trim())aiOutputPhotoIds.add(photoId);
    });
    const hasAnyAiOutput=aiOutputPhotoIds.size>0;
    const issueGroups=buildIssueGroups(issues,form.issueDrafts).map(group=>{
      const aiObservations=observationByPhoto.get(group.key)||[];
      const observationText=new Set(aiObservations.map(text=>`${text||''}`.trim()).filter(Boolean));
      const reviewIssues=group.issues.map(issue=>({
        ...issue,
        // The same sentence can arrive once as a photo-level observation and
        // again as an issue's visual evidence. Keep it in the photo context
        // and avoid repeating it beneath the individual issue.
        hideVisualEvidence:Boolean(issue.visualEvidence&&observationText.has(`${issue.visualEvidence}`.trim()))
      }));
      const sourcePhoto=photos[group.sourceIndex]||{};
      const aiWasSelected=sourcePhoto.analysisMode==='ai'||sourcePhoto.analysisModeResolved==='ai';
      // A single page-level empty notice is enough when the whole AI batch is
      // empty. Keep per-photo notices only for partial results, where they
      // identify which particular photo still needs manual attention.
      return {...group,issues:reviewIssues,aiObservations,aiEmpty:aiRequested&&hasAnyAiOutput&&aiWasSelected&&!aiOutputPhotoIds.has(group.key)};
    });
    this.setData({summaryEdited,reviewNeedsAttention,reviewStalePhotoIds:draft.review?.stalePhotoIds||[],submissionLocked:!!draft.submission?.requestId,draftKey:key,sessionKey:draft.sessionId || draft.sessionKey || key,returnContext:draft.returnContext || null,form,mediaLoadError:"",
      originalIssues:draft.review ? draft.review.originalItems : JSON.parse(JSON.stringify(issues)),issues,
      issueGroups,
      summary:{projectName:form.projectName||"未命名项目",title:form.title||"本次巡查",contextNote:form.note||"",aiSummary:savedSummary,issueCount:issues.filter(item=>(item.description||"").trim()).length,aiIssueCount:(analysis.items||[]).filter(item=>(item.description||"").trim()).length,aiObservationCount:(analysis.observations||[]).length,aiHasOutput:hasAnyAiOutput,aiRequested,visionRequested,textOrganizationRequested,aiMode:aiRequested?"model":(analysis.aiMode||""),memoryHint:analysis.memoryHint||"",memoryAlerts:analysis.memoryAlerts||[]}});
    this.loadReviewMedia(issueGroups,form.issueDrafts);
    this.persistReview();
  },
  async loadReviewMedia(groups = this.data.issueGroups || [], photos = this.data.form?.issueDrafts || []) {
    const generation=(this.data.mediaLoadGeneration||0)+1;
    this.setData({mediaLoadGeneration:generation,mediaLoadError:""});
    const ids=photos.map(photo=>getPhotoDisplayPath(photo)).filter(isCloudFileId);
    if(!ids.length)return;
    const result=await resolveCloudFileUrls(ids);
    if(generation!==this.data.mediaLoadGeneration)return;
    const nextGroups=groups.map(group=>{
      const source=photos[group.sourceIndex] || photos.find(photo=>photo.id===group.key);
      const sourcePath=source ? getPhotoDisplayPath(source) : group.image;
      return {...group,image:result.urls[sourcePath] || sourcePath || group.image};
    });
    this.setData({issueGroups:nextGroups,mediaLoadError:result.failed.length?"部分照片暂时无法显示，请重新加载":""});
  },
  retryReviewMedia(){return this.loadReviewMedia(this.data.issueGroups,this.data.form?.issueDrafts||[]);},
  retryAiRecognition(){
    if(this.data.submitting||this.data.submissionLocked||!this.data.sessionKey)return;
    const draft=readDraft(this.data.sessionKey),photos=draft.form?.issueDrafts||[];
    const retryPhotoIds=photos.filter(photo=>photo.imagePath&&(
      photo.analysisMode==='ai'||(!['manual','pending'].includes(photo.analysisMode)&&!`${photo.voiceText||''}`.trim())
    )).map(photo=>photo.id).filter(Boolean);
    if(!retryPhotoIds.length){wx.showToast({title:'没有选择 AI 识图的照片',icon:'none'});return;}
    try{
      patchDraft(this.data.sessionKey,{
        phase:'capture',taskId:'',analysisRequestId:identity('analysis-retry'),retryRequested:true,
        review:{...(draft.review||{}),stale:true,stalePhotoIds:[...new Set([...(draft.review?.stalePhotoIds||[]),...retryPhotoIds])]}
      });
    }catch(error){wx.showModal({title:'暂时无法重新识图',content:error.message||'照片与问题仍已保留，请返回现场记录重试。',showCancel:false});return;}
    wx.navigateBack({delta:1,fail:()=>wx.showModal({title:'无法返回现场记录',content:'草稿已保留。请返回项目后继续这份未完成记录。',showCancel:false})});
  },
  onHide(){if(!this.published)this.persistReview();},
  onUnload(){if(!this.published)this.persistReview();},
  persistReview(){
    if(!this.data.form || !this.data.sessionKey)return false;
    try {
      writeDraft(this.data.sessionKey,this.data.form,this.data.returnContext);
      patchDraft(this.data.sessionKey,{phase:this.data.submitting?"submitting":"review",review:{items:this.data.issues,originalItems:this.data.originalIssues,summary:this.data.summary.aiSummary,summaryEdited:this.data.summaryEdited,stale:this.data.reviewNeedsAttention,stalePhotoIds:this.data.reviewStalePhotoIds}});
      return true;
    }catch(e){wx.showModal({title:"草稿保存失败",content:e.message||"请勿关闭，释放存储后重试",showCancel:false});return false;}
  },
  handleBackTap(){if(!this.persistReview())return;wx.navigateBack({delta:1,fail:()=>returnToContext(this.data.returnContext)});},
  handleHomeTap(){if(this.persistReview())wx.switchTab({url:"/pages/project/list/index"});},
  updateIssues(issues){const count=issues.filter(item=>(item.description||"").trim()).length;if(!this.data.summaryEdited)this.setData({"summary.aiSummary":""});this.setData({issues,issueGroups:buildIssueGroups(issues,this.data.form.issueDrafts),"summary.issueCount":count});this.persistReview();},
  handleItemChange(event){
    if(this.data.submissionLocked){wx.showToast({title:"请继续完成同一次提交",icon:"none"});return;}
    const {index,field,value}=event.detail;
    if(!["description","suggestion","severity","responsibleParty","responsiblePartyName","category","area"].includes(field)||!this.data.issues[index])return;
    this.updateIssues(this.data.issues.map((p,i)=>i===index?{...p,[field]:value,...(field==='responsiblePartyName'?{responsibleParty:'pending'}:{}),editedFields:[...new Set([...(p.editedFields||[]),field,...(field==='responsiblePartyName'?['responsibleParty']:[])])]}:p));
  },
  handleAddIssue(event){
    if(this.data.submissionLocked)return;
    const photos=this.data.form.issueDrafts || [], index=Number(event.currentTarget.dataset.index || 0),p=photos[index];
    if(p){
      const markers=(p.annotations||[]).filter(annotation=>
        annotation.type==="point"||((annotation.type==="box"||annotation.type==="ellipse")&&annotation.numbered===true)
      );
      const used=new Set(this.data.issues.filter(item=>item.sourcePhotoId===p.id&&item.annotationId).map(item=>item.annotationId));
      const markerIndex=markers.findIndex(annotation=>!used.has(annotation.id));
      const marker=markerIndex>=0?markers[markerIndex]:null;
      this.updateIssues(this.data.issues.concat({
        id:identity("issue"),sourcePhotoId:p.id,sourceIndex:index,
        ...(marker?{annotationId:marker.id,markerNumber:markerIndex+1,subIssueIndex:markerIndex+1}:{}),
        description:"",suggestion:"",severity:"normal",responsibleParty:"pending"
      }));
    }
  },
  handleDeleteIssue(event){
    if(this.data.submissionLocked)return;
    const index=Number(event.detail?.index ?? event.currentTarget?.dataset?.index),target=this.data.issues[index];if(!target)return;
    if(target.markerNumber || target.annotationId){
      const marker=target.markerNumber || target.subIssueIndex || "";
      wx.showModal({title:"这条问题有照片标注",content:`问题 ${marker}. 对应照片上的标注 ${marker}。请先返回照片删除或调整标注，再删除问题，避免报告编号错配。`,confirmText:"返回照片",cancelText:"暂不删除",success:r=>{
        if(r.confirm && this.persistReview())wx.navigateBack({delta:1,fail:()=>returnToContext(this.data.returnContext)});
      }});
      return;
    }
    wx.showModal({title:"删除这条问题？",content:"照片仍保留为现场记录。",confirmText:"删除",confirmColor:"#C13D2A",success:r=>{
      if(r.confirm)this.updateIssues(this.data.issues.filter((_,i)=>i!==index));
    }});
  },
  handleAcceptAllAndSubmit(){if(typeof wx.vibrateShort==='function')wx.vibrateShort({type:'light'});return this.handleSubmit();},
  ...coachMethods("reviewPublish","#coach-review-submit"),
  async handleSubmit(){
    if(this.data.submitting){wx.showToast({title:"正在保存，请稍候",icon:"none"});return;}
    if(!this.data.form){wx.showModal({title:"记录尚未就绪",content:"没有读取到本次核对内容。返回现场记录恢复草稿后再试。",showCancel:false});return;}
    const blank=this.data.issues.filter(item=>!(item.description||"").trim());
    const linkedBlank=blank.filter(item=>item.annotationId || Number(item.markerNumber)>0);
    if(linkedBlank.length){
      const pointNumbers=linkedBlank.map(item=>item.markerNumber||item.subIssueIndex).filter(Boolean);
      wx.showModal({title:"有标注还没有说明",content:`${pointNumbers.length?`照片标注 ${pointNumbers.join("、")} `:"部分照片标注"}尚未对应问题说明。请补充说明，或返回照片移除对应标注，再生成报告。`,confirmText:"知道了",showCancel:false});
      return;
    }
    if(blank.length){
      wx.showModal({title:"移除空白问题？",content:`${blank.length} 条未填写的问题不会进入报告。确认移除并继续生成吗？`,confirmText:"移除并继续",cancelText:"返回填写",success:result=>{
        if(!result.confirm)return;
        const issues=this.data.issues.filter(item=>(item.description||"").trim());
        this.updateIssues(issues);
        // 移除空白行之后同样要过标注核对，否则「有标注 + 一条空白问题」
        // 会从这个分支直接发布出去，绕过下面那道拦截。
        this.submitAfterAnnotationCheck(issues);
      }});
      return;
    }
    return this.submitAfterAnnotationCheck(this.data.issues);
  },
  /**
   * 发布前的最后一道：有编号标注、却没有任何带说明问题的照片。
   *
   * 报告里的编号是从「问题条目」推出来的（group.markers 只认 issue），
   * 没有对应问题，标注号就会整个从报告里消失——照片照常显示，但编号和
   * 说明都不见了。真机实测中这正是「我明明标了位置 1，报告里什么都没有」。
   */
  submitAfterAnnotationCheck(issues){
    const orphan=this.photosWithAnnotationsButNoIssue(issues);
    if(orphan.length){
      wx.showModal({
        title:"有标注没有对应问题",
        content:`照片 ${orphan.join("、")} 上有标注，但没有写问题。生成报告后这些编号不会出现。请补充问题说明，或返回照片移除标注。`,
        confirmText:"知道了",
        showCancel:false
      });
      return;
    }
    return this.submitReviewedIssues(issues);
  },
  /** 有编号标注、但没有一条带说明的问题的照片序号 */
  photosWithAnnotationsButNoIssue(issues){
    const photos=(this.data.form && this.data.form.issueDrafts) || [];
    const list=Array.isArray(issues) ? issues : (this.data.issues || []);
    return photos.map((photo,index)=>{
      const markers=(photo.annotations || []).filter(isNumberedAnnotation);
      if(!markers.length)return "";
      const answered=list.some(item=>item.sourcePhotoId===photo.id && (item.description||"").trim());
      return answered ? "" : String(index+1);
    }).filter(Boolean);
  },
  async submitReviewedIssues(issues){
    if(this.data.submitting || !this.data.form)return;
    if(!this.persistReview()){wx.showToast({title:"内容暂未保存，请检查提示",icon:"none"});return;}
    this.setData({submitting:true});wx.showLoading({title:"保存记录",mask:true});
    try{
      const form=await uploadDraftMedia(this.data.form,async form=>{this.setData({form});if(!this.persistReview())throw new Error("草稿保存失败");});
      this.setData({form});if(!this.persistReview())throw new Error("草稿保存失败");
      const draft=readDraft(this.data.sessionKey),requestId=draft.submission?.requestId || identity("submit");
      patchDraft(this.data.sessionKey,{submission:{...draft.submission,requestId},phase:"submitting"});
      this.setData({submissionLocked:true});
      const inspectorSummary=this.data.summaryEdited ? `${this.data.summary.aiSummary || ""}`.trim() : "";
      const result=draft.submission?.inspectionId?{inspectionId:draft.submission.inspectionId}:await confirmInspection({requestId,form:{...form,aiSummary:inspectorSummary,summarySource:inspectorSummary ? "inspector" : ""},items:resolveIssueMedia(issues,form.issueDrafts),originalItems:this.data.originalIssues});
      patchDraft(this.data.sessionKey,{submission:{requestId,inspectionId:result.inspectionId},phase:"submitting"});
      const reportData=await buildReportData({inspectionId:result.inspectionId});
      const report=await saveReport({...reportData,requestId:"report-"+result.inspectionId,status:"published"});
      if(!report || !report._id)throw new Error("报告保存未确认，请重试；巡查不会重复创建");
      markGuideStep("inspectionSubmitted",true);this.published=true;finishDraft(this.data.sessionKey);
      if(this.data.draftKey!==this.data.sessionKey)wx.removeStorageSync(this.data.draftKey);
      const context=encodeReturnContext(this.data.returnContext);
      // 报告已生成，引导推进到「转发给业主」
      this.advanceCoach();
      wx.redirectTo({
        url:"/pages/report/detail/index?reportId="+report._id+(context?"&returnContext="+context:""),
        fail:error=>{
          console.error("[inspection-review] published report could not open",error);
          wx.showModal({
            title:"报告已生成",
            content:"报告已保存，可在“报告”中查看。当前页面跳转失败，不要重复提交。",
            confirmText:"打开报告列表",
            cancelText:"留在此页",
            success:choice=>{if(choice.confirm)wx.switchTab({url:"/pages/report/list/index"});}
          });
        }
      });
    }catch(e){wx.showModal({title:"尚未完成交付",content:(e.message||"请检查网络")+"\n输入已保留，重试继续同一份记录。",showCancel:false});}
    finally{wx.hideLoading();this.setData({submitting:false});}
  }
});
