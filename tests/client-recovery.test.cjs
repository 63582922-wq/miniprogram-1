const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

function loadPage(relative,dependencies={},wx={},timers={}){
 let config;const filename=path.resolve(__dirname,'../miniprogram/pages',relative,'index.js');
 const context={Page:c=>config=c,wx,console,Date,Math,setTimeout,clearTimeout,...timers,
  require:n=>dependencies[n]||require(path.resolve(path.dirname(filename),n))};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 const page={...config,data:structuredClone(config.data),setData(p){Object.entries(p).forEach(([key,value])=>{if(!key.includes('.')){this.data[key]=value;return;}const [root,nested]=key.split('.');this.data[root]={...(this.data[root]||{}),[nested]:value};})}};
 return {page,context};
}

function loadComponent(relative,dependencies={},wx={}){
 let config;const filename=path.resolve(__dirname,'../miniprogram/components',relative,'index.js');
 const context={Component:c=>config=c,wx,console,Date,Math,setTimeout,clearTimeout,
  require:n=>dependencies[n]||require(path.resolve(path.dirname(filename),n))};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 const component={...config.methods,data:structuredClone(config.data||{}),properties:{},setData(p){Object.assign(this.data,p)},triggerEvent(){}};
 return {component,config,context};
}

test('capture starts recording on touch down without long-press or another settings request',async()=>{
 let starts=0;
 const {page}=loadPage('inspection/create',{}, {
  getRecorderManager:()=>({start(){starts++;}}),
  getSetting(){assert.fail('cached permission must avoid request on press');}
 });
 page.recordPermissionReady=true;
 page.data.form.issueDrafts=[{id:'photo',voiceText:''}];
 const promise=page.handleRecordTouchStart({touches:[{clientY:200}],currentTarget:{dataset:{index:0}}});
 assert.equal(starts,1,'recording starts immediately in the touch handler');
 await promise;assert.equal(page.data.transcribingIssueId,'photo');
});

test('releasing during microphone authorization never starts unattended recording',async()=>{
 let allow,starts=0;
 const {page}=loadPage('inspection/create',{}, {
  getRecorderManager:()=>({start(){starts++;}}),
  getSetting:o=>o.success({authSetting:{}}),authorize:o=>{allow=o.success;}
 });
 page.data.form.issueDrafts=[{id:'photo',voiceText:''}];
 const promise=page.handleRecordTouchStart({touches:[{clientY:200}],currentTarget:{dataset:{index:0}}});
 await Promise.resolve();page.handleRecordTouchEnd();allow();await promise;
 assert.equal(starts,0);assert.equal(page.data.transcribingIssueId,'');
});

test('AI advance rejection stops waiting without deleting the resumable task',async()=>{
 const {page}=loadPage('inspection/create',{
  '../../../services/inspection':{advanceInspectionTask:()=>Promise.reject(new Error('服务暂不可用'))}
 },{getRecorderManager:()=>({})});
 page.data.analyzeTaskId='task-one';page.data.analyzing=true;page.waitingForAnalysis=true;
 page.clearAnalyzeTaskPolling=()=>{};page.scheduleAnalyzeTaskPolling=()=>assert.fail('must not resume spinning');
 page.startAnalyzeTaskAdvancement();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(page.data.analyzing,false);assert.equal(page.waitingForAnalysis,false);
 assert.equal(page.data.analyzeTaskId,'task-one');assert.equal(page.data.analyzeError,'服务暂不可用');
});

test('unchanged 0/1 AI progress and cancelled tasks terminate the spinner',async()=>{
 for(const status of ['running','cancelled']){
  const {page}=loadPage('inspection/create',{
   '../../../services/inspection':{readInspectionTaskStatus:async()=>({status,totalPhotos:1,completedPhotos:0})},
   '../../../utils/inspection-draft':{readDraft:()=>({inputVersion:1})}
  },{getRecorderManager:()=>({})});
  page.data.analyzeTaskId='task-one';page.waitingForAnalysis=true;page.pendingInputVersion=1;
  page.analyzeProgressKey='task-one:0';page.analyzeProgressAt=Date.now()-211000;
  page.clearAnalyzeTaskPolling=()=>{};page.startAnalyzeTaskAdvancement=()=>assert.fail('no more advance calls');
  assert.equal(await page.pollAnalyzeTaskStatus(),status==='cancelled'?'cancelled':'stalled');
  assert.equal(page.data.analyzing,false);assert.equal(page.data.analyzeTaskId,'task-one');
 }
});

test('annotation undo and redo restore the shape operation, not page navigation',()=>{
 const {component}=loadComponent('annotation-canvas');
 component.shapes=[{id:'one'}];component.undoStack=[[]];component.redoStack=[];
 component.emit=()=>{};component.draw=()=>{};
 component.undo();assert.equal(component.shapes.length,0);assert.equal(component.redoStack.length,1);
 component.redo();assert.equal(component.shapes[0].id,'one');assert.equal(component.undoStack.length,1);
});

function loadService(relative,{wx={},getApp=()=>null}={}){
 const filename=path.resolve(__dirname,'../miniprogram/services',relative+'.js');
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,wx,getApp,console,Date,Math,Promise,Error,Object,Array,String,Boolean,Number,JSON,setTimeout,clearTimeout});
 return module.exports;
}

test('zero-issue inspection keeps annotated photos visible and previewable',async()=>{
 let preview;
 const {page}=loadPage('inspection/detail',{
  '../../../services/inspection':{getInspectionDetail:async()=>({inspection:{photos:[{id:'p',imagePath:'cloud://original',annotatedImagePath:'cloud://marked',caption:'现场记录'}]},items:[]})},
  '../../../services/cloud-media':{isCloudFileId:s=>s.startsWith('cloud://'),resolveCloudFileUrls:async()=>({urls:{'cloud://marked':'https://example.test/marked.jpg'}})}
 },{previewImage:o=>preview=o});
 page.data.inspectionId='existing';await page.loadDetail();
 assert.equal(page.data.items.length,0);assert.equal(page.data.photos.length,1);
 assert.equal(page.data.photos[0].previewUrl,'https://example.test/marked.jpg');
 page.previewPhoto({currentTarget:{dataset:{index:0}}});assert.equal(preview.current,'https://example.test/marked.jpg');
});

test('analysis progress photo numbers are stable, human-facing and deduplicated',()=>{
 const {page}=loadPage('inspection/create',{}, {getRecorderManager:()=>({})});
 assert.equal(page.formatAnalyzePhotoNumbers([3,1,3,0]),'01、02、04');
 assert.equal(page.formatAnalyzePhotoNumbers([]),'');
 assert.equal(page.formatAnalyzePhotoNumbers(['bad',-1]),'');
});

test('inspection history issue thumbnails prefer the saved annotated photo and preserve legacy fallback',()=>{
 const {component,config}=loadComponent('inspection-item-card');
 const observer=config.observers['item, index, displayIndex, titleText, hideTitle, editable'];
 component.properties={editable:false,index:0,displayIndex:0,titleText:'',hideTitle:false};
 observer.call(component,{id:'issue-marked',description:'标注位置对应的问题',images:['/photo-original.jpg'],annotatedImages:['/photo-with-mark.jpg']});
 assert.deepEqual(component.data.displayImages,['/photo-with-mark.jpg']);
 observer.call(component,{id:'issue-legacy',description:'旧记录',images:['/legacy-photo.jpg']});
 assert.deepEqual(component.data.displayImages,['/legacy-photo.jpg']);
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/components/inspection-item-card/index.wxml'),'utf8');
 assert.match(markup,/wx:for="\{\{displayImages\}\}"/);
});

test('AI polling exhaustion keeps a real retry/manual recovery panel and does not name a missing action',()=>{
 let modalShown=0;
 const {page}=loadPage('inspection/create',{}, {getRecorderManager:()=>({}),showModal(){modalShown++;}}, {setTimeout(){return 1;},clearTimeout(){}});
 page.data.analyzeTaskId='task-resume';
 page.data.analyzeCompletedPhotos=3;
 page.data.analyzeTotalPhotos=8;
 page.analyzePollFailureCount=5;
 page.clearAnalyzeTaskPolling=()=>{};
 page.handleAnalyzePollError(new Error('network unavailable'));
 assert.equal(page.data.analyzing,false);
 assert.equal(page.data.analyzeTaskId,'task-resume','the existing task must remain resumable');
 assert.equal(page.data.analyzeError,'网络不稳定，暂时无法取得分析结果。可重试未完成照片，也可直接人工核对。');
 assert.equal(page.data.analyzeStageText,'已完成 3/8 张，进度已保存');
 assert.equal(modalShown,0,'the persistent panel itself provides the real recovery actions');
});

test('rapid repeated taps on retry resume one AI task only',()=>{
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{readDraft:()=>({inputVersion:7})}
 },{getRecorderManager:()=>({})});
 let advances=0,polls=0;
 page.data.sessionKey='session-retry';
 page.data.analyzeTaskId='task-partial-8-photos';
 page.data.analyzeCompletedPhotos=4;
 page.data.analyzeTotalPhotos=8;
 page.startAnalyzeTaskAdvancement=()=>{advances++;};
 page.scheduleAnalyzeTaskPolling=()=>{polls++;};

 page.handleRetryAnalyze();
 page.handleRetryAnalyze();

 assert.equal(advances,1,'a second tap while retry is active must not advance the task again');
 assert.equal(polls,1,'a second tap must not create another polling loop');
 assert.equal(page.data.analyzing,true);
 assert.equal(page.data.analyzeError,'');
});

test('hidden capture page cannot overwrite annotation draft on unload and releases native guard',()=>{
 let writes=0,disabled=0;
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{writeDraft(){writes++},readDraft:()=>({})}
 },{getRecorderManager:()=>({}),getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){},
  enableAlertBeforeUnload(){},disableAlertBeforeUnload(){disabled++}});
 page.data.sessionKey='s';page.data.form.issueDrafts=[{id:'photo',annotations:[]}];
 page.ownsDraft=true;page.suspendDraftOnHide=true;page.clearAnalyzeTaskPolling=()=>{};
 page.onHide();assert.equal(writes,1);assert.equal(disabled,1);
 page.onUnload();assert.equal(writes,1,'stale capture must not replace newer annotation data');
});

test('camera or album roundtrip keeps capture ownership and does not restore over the picker callback',async()=>{
 let writes=0,reads=0;
 const draft={form:{projectId:'p',issueDrafts:[]}};
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{
   writeDraft(){writes++},readDraft:()=>draft,
   extractDraftForm:value=>value.form,
   extractDraftReturnContext:()=>null,
   createDraftSnapshot:value=>value,
   patchDraft(){}
  }
 },{getRecorderManager:()=>({}),getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){},disableAlertBeforeUnload(){}});
 page.data.sessionKey='s';page.data.form={projectId:'p',issueDrafts:[]};page.clearAnalyzeTaskPolling=()=>{};
 page.restoreDraft=()=>{reads++};page.ownsDraft=true;page.pickerInFlight=true;
 page.onHide();
 assert.equal(page.ownsDraft,true,'system picker must not hand the draft to another page');
 await page.onShow();
 assert.equal(reads,0,'onShow must not restore the stale snapshot while picker callback is pending');
 assert.equal(writes,1,'current capture state is still autosaved before the picker opens');
});

test('successful camera picker callback persists and immediately displays the photo under the selected project',async()=>{
 const {page}=loadPage('inspection/create',{
  '../../../services/inspection-media':{keepLocalFile:async path=>`/user-data/${path.split('/').pop()}`},
  '../../../utils/inspection-draft':{writeDraft(){},readDraft:()=>({})}
 },{
  getRecorderManager:()=>({}),getAppBaseInfo:()=>({platform:'devtools'}),
  chooseImage(options){options.success({tempFilePaths:['/tmp/real-user-photo.jpg']});},
  showToast(){},getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){}
 });
 page.data.sessionKey='session-B';page.data.form={projectId:'project-B',projectName:'项目 B',issueDrafts:[]};
 page.persistDraft=()=>true;
 page.chooseImages({currentTarget:{dataset:{sourceType:'camera'}}});
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(page.data.form.projectId,'project-B');
 assert.equal(page.data.issueDraftCount,1);
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/user-data/real-user-photo.jpg');
 assert.equal(page.data.form.issueDrafts[0].displayImagePath,'/user-data/real-user-photo.jpg');
 assert.equal(page.data.photoChoiceOpen,false,'photo actions are directly visible; importing no longer opens a redundant mode chooser');
 assert.deepEqual(Array.from(page.data.photoChoiceIds),[]);
});

test('picker routing uses mini-program runtime info, not the host Mac device info',async()=>{
 const calls=[];
 const {context}=loadPage('inspection/create',{}, {
  getRecorderManager:()=>({}),
  getAppBaseInfo:()=>({platform:'devtools'}),getDeviceInfo:()=>({platform:'mac'}),
  chooseImage(options){calls.push('chooseImage');options.success({tempFilePaths:['/tmp/devtools.jpg']});},
  chooseMedia(){calls.push('chooseMedia');}
 });
 const paths=await context.choosePhotoFiles({count:1,sourceType:['album']});
 assert.deepEqual(calls,['chooseImage']);
 assert.deepEqual(Array.from(paths),['/tmp/devtools.jpg']);
});

test('real mini-program runtime keeps chooseMedia as the primary photo picker',async()=>{
 const calls=[];
 const {context}=loadPage('inspection/create',{}, {
  getRecorderManager:()=>({}),getSystemInfoSync(){calls.push('deprecatedSystemInfo');throw new Error('deprecated API should not be called');},
  getAppBaseInfo:()=>({platform:'ios'}),getDeviceInfo:()=>({platform:'mac'}),
  chooseImage(options){calls.push('chooseImage');options.success({tempFilePaths:['/tmp/legacy.jpg']});},
  chooseMedia(options){calls.push('chooseMedia');options.success({tempFiles:[{tempFilePath:'/tmp/phone.jpg'}]});}
 });
 const paths=await context.choosePhotoFiles({count:1,sourceType:['album']});
 assert.deepEqual(calls,['chooseMedia']);
 assert.deepEqual(Array.from(paths),['/tmp/phone.jpg']);
});

test('capture exposes the current picker/save status instead of looking idle while a photo is being committed',async()=>{
 const {page}=loadPage('inspection/create',{
  '../../../services/inspection-media':{keepLocalFile:()=>new Promise(()=>{})},
  '../../../utils/inspection-draft':{writeDraft(){},readDraft:()=>({})}
 },{
  getRecorderManager:()=>({}),getAppBaseInfo:()=>({platform:'devtools'}),
  chooseImage(options){options.success({tempFilePaths:['/tmp/photo.jpg']});},showToast(){},getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){}
 });
 page.data.sessionKey='saving-session';page.data.form={projectId:'qa',projectName:'隔离项目',issueDrafts:[]};page.persistDraft=()=>true;
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(page.data.pickingImages,true);
 assert.equal(page.data.pickerStatusText,'正在保存…');
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/create/index.wxml'),'utf8');
 assert.match(markup,/wx:if="\{\{pickingImages\}\}" class="photo-picker-status"[\s\S]*?\{\{pickerStatusText/);
 page.pickerEpoch+=1;clearTimeout(page.pickerTimer);
});

test('reanalyzing changed photos preserves reviewed issues on untouched photos and refreshes the summary count',()=>{
 const {context}=loadPage('inspection/create',{}, {getRecorderManager:()=>({})});
 const form={issueDrafts:[{id:'old'},{id:'new'}]};
 const draft={review:{stale:true,stalePhotoIds:['new'],summary:'本次记录 1 张照片，确认 1 条问题。',summaryEdited:false,
  items:[{id:'human',sourcePhotoId:'old',description:'人工已确认'}],originalItems:[{id:'old-ai',sourcePhotoId:'old'}]}};
 const merged=context.mergeReanalyzedReview(draft,{items:[{id:'fresh',sourceIndex:1,description:'新增照片建议'}]},form);
 assert.deepEqual(merged.items.map(item=>item.id),['human','fresh']);
 assert.equal(merged.items[1].sourcePhotoId,'new');
 assert.equal(merged.summary,'','an untouched count-only summary should not be carried into the report');
 assert.equal(merged.stale,false);
 const observations=context.mergeReanalyzedObservations({...draft,analysis:{observations:[{sourcePhotoId:'old',text:'旧照片观察'},{sourcePhotoId:'new',text:'旧的新照片观察'}]}},{observations:[{sourcePhotoId:'new',sourceIndex:1,text:'新照片观察'}]},form);
 assert.equal(JSON.stringify(observations.map(item=>[item.sourcePhotoId,item.text])),JSON.stringify([['old','旧照片观察'],['new','新照片观察']]));
});

test('capture relies on autosave and never enables a native unload guard that can leak across pages',async()=>{
 let enabled=0,disabled=0;
 const draft={form:{projectId:'p',issueDrafts:[{id:'photo',annotations:[]}]}};
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{
   writeDraft(){},readDraft:()=>draft,
   extractDraftForm:value=>value.form,
   extractDraftReturnContext:()=>null,
   createDraftSnapshot:value=>value,
   patchDraft(){}
  }
 },{getRecorderManager:()=>({}),getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){},
  enableAlertBeforeUnload(){enabled++},disableAlertBeforeUnload(){disabled++}});
 page.data.sessionKey='s';page.clearAnalyzeTaskPolling=()=>{};
 await page.onShow();
 assert.equal(enabled,0,'autosaved capture must not install a system-level Back interceptor');
 page.onHide();assert.equal(disabled,1);
});

test('text organization is requested by Next without changing the selected manual photo mode',async()=>{
 const {page}=loadPage('inspection/create',{'../../../utils/inspection-draft':{readDraft:()=>({form:{}})}},{getRecorderManager:()=>({})});
 page.data.form={projectId:'p',issueDrafts:[{id:'a',analysisMode:'manual',voiceText:'次卧收口，由王工补胶'},{id:'b',analysisMode:'manual',voiceText:''}]};
 let analyzed=0,manual=0;page.persistDraft=()=>true;page.handleAnalyze=()=>{analyzed++};page.handleManualReview=()=>{manual++};
 await page.handleContinueReview();
 assert.equal(analyzed,1);assert.equal(manual,0);assert.equal(page.data.form.issueDrafts[0].organizeText,true);
 assert.equal(page.data.form.issueDrafts[0].analysisMode,'manual');assert.equal(page.data.form.issueDrafts[1].organizeText,false);
 assert.equal(page.data.nextActionLabel,'整理说明并核对');
});

test('one AI photo does not opt three unselected photos into recognition',async()=>{
 const {page}=loadPage('inspection/create',{'../../../utils/inspection-draft':{readDraft:()=>({form:{}})}},{getRecorderManager:()=>({})});
 page.data.form={projectId:'p',issueDrafts:Array.from({length:4},(_,i)=>({id:'photo'+i,imagePath:'local'+i,analysisMode:i===0?'ai':'pending',voiceText:''}))};
 page.persistDraft=()=>true;let analyzed=0;page.handleAnalyze=()=>{analyzed++};
 page.handleManualReview=()=>{};
 await page.handleContinueReview();assert.equal(analyzed,0,'bottom action must not launch image recognition');
 assert.equal(page.data.form.issueDrafts.filter(photo=>photo.analysisMode==='ai').length,0);
 assert.equal(page.data.form.issueDrafts.filter(photo=>photo.analysisMode==='manual').length,4);
});

test('explicitly adopted AI observation becomes a persisted photo caption without inventing a problem',()=>{
 const {page}=loadPage('inspection/result');
 page.data.form={projectId:'p',issueDrafts:[{id:'photo',caption:''}]};
 page.data.issueGroups=[{key:'photo',issues:[],aiObservations:['可见木作接缝'],caption:''}];
 page.data.issues=[];let saves=0;page.persistReview=()=>{saves++;return true};
 page.acceptObservation({currentTarget:{dataset:{photoId:'photo'}}});
 assert.equal(page.data.form.issueDrafts[0].caption,'可见木作接缝');
 assert.equal(page.data.issueGroups[0].caption,'可见木作接缝');assert.equal(saves,1);assert.equal(page.data.issues.length,0);
});

test('keyboard text entry is autosaved, routed to text organization, and never implicitly opts into photo AI',async()=>{
 const {page}=loadPage('inspection/create',{'../../../utils/inspection-draft':{readDraft:()=>({form:{}})}},{getRecorderManager:()=>({})});
 page.data.sessionKey='typed-text-session';
 page.data.form={projectId:'p',issueDrafts:[{id:'typed-photo',analysisMode:'manual',voiceText:''}]};
 let saved=0,analyzed=0,manual=0;
 page.persistDraft=()=>{saved++;return true};
 page.handleAnalyze=()=>{analyzed++};
 page.handleManualReview=()=>{manual++};
 page.handleIssueVoiceTextInput({currentTarget:{dataset:{id:'typed-photo'}},detail:{value:'次卧窗台收口缺胶，区域：次卧窗台；责任方：木作班组。'}});
 assert.equal(saved,1);
 assert.equal(page.data.form.issueDrafts[0].voiceText,'次卧窗台收口缺胶，区域：次卧窗台；责任方：木作班组。');
 assert.equal(page.data.form.issueDrafts[0].analysisMode,'manual');
 assert.equal(page.data.nextActionLabel,'整理说明并核对');
 await page.handleContinueReview();
 assert.equal(analyzed,1,'typed text is sent through the text-organizing/review task');
 assert.equal(manual,0);
 assert.equal(page.data.form.issueDrafts[0].organizeText,true);
 assert.equal(page.data.form.issueDrafts[0].analysisMode,'manual','typing must not silently enable image recognition');
});

test('analysis progress heading reflects text-only, photo-only, and mixed processing without implying an unselected mode',async()=>{
 const titles=[
  {photos:[{id:'text',imagePath:'/photo.jpg',analysisMode:'manual',voiceText:'窗台收口缺胶',organizeText:true}],expected:'正在整理现场说明'},
  {photos:[{id:'vision',imagePath:'/photo.jpg',analysisMode:'ai',voiceText:'',organizeText:false}],expected:'正在识别现场照片'},
  {photos:[{id:'vision',imagePath:'/photo-a.jpg',analysisMode:'ai',voiceText:'',organizeText:false},{id:'text',imagePath:'/photo-b.jpg',analysisMode:'manual',voiceText:'门套收口缺胶',organizeText:true}],expected:'正在整理现场记录'}
 ];
 for(const {photos,expected} of titles){
  const {page}=loadPage('inspection/create',{
   '../../../utils/inspection-draft':{readDraft:()=>({inputVersion:1})}
  },{getRecorderManager:()=>({})},{console:{error(){}}});
  page.data.sessionKey='session';page.data.form={projectId:'p',issueDrafts:photos};
  page.uploadAssets=async()=>{throw Error('stop after progress state is set')};
  page.handleAnalyzePollError=()=>{};
  await page.handleAnalyze();
  assert.equal(page.data.analyzePanelTitle,expected);
 }
});

test('reorganization cannot replace a responsibility or area edited by the inspector',()=>{
 const {context}=loadPage('inspection/create',{}, {getRecorderManager:()=>({})});
 const form={issueDrafts:[{id:'p'}]},old={id:'text-1',sourcePhotoId:'p',sourceQuote:'原话',description:'原话',area:'现场确认区域',responsiblePartyName:'现场确认单位',editedFields:['area','responsiblePartyName']};
 const merged=context.mergeReanalyzedReview({review:{stale:true,stalePhotoIds:['p'],items:[old],originalItems:[]}},
  {items:[{id:'text-1',sourcePhotoId:'p',sourceQuote:'原话',area:'模型区域',responsiblePartyName:'模型单位'}]},form);
 assert.equal(merged.items[0].area,'现场确认区域');assert.equal(merged.items[0].responsiblePartyName,'现场确认单位');
});

test('manual fallback rebuilds changed source text instead of opening an outdated review',async()=>{
 const {page}=loadPage('inspection/create',{'../../../utils/inspection-draft':{readDraft:()=>({review:{stale:true}})}},{getRecorderManager:()=>({}),navigateTo(){throw Error('must refresh before navigating')}});
 page.data.form={projectId:'p',issueDrafts:[{id:'photo',voiceText:'次卧收口需要补胶'}]};
 let analyzed;
 page.completeAnalyzeSuccess=async(form,analysis)=>{analyzed=analysis};
 await page.handleManualReview();
 assert.equal(analyzed.aiMode,'manual');assert.equal(analyzed.items[0].description,'次卧收口需要补胶');
});

test('blank review placeholders do not count as problems or consume formal issue numbers',()=>{
 const {context}=loadPage('inspection/result',{},{});
 const groups=context.buildIssueGroups([
  {id:'empty',sourcePhotoId:'p',description:'',subIssueIndex:1},
  {id:'filled',sourcePhotoId:'p',description:'已确认问题',subIssueIndex:2}
 ],[{id:'p',imagePath:'local.jpg'}]);
 assert.equal(groups[0].statusText,'1 项问题 · 1 条待补充');
 assert.equal(groups[0].issues[0].displayNo,'');
 assert.equal(groups[0].issues[1].displayNo,'1.');
 const onlyBlank=context.buildIssueGroups([{id:'empty',sourcePhotoId:'p',description:''}],[{id:'p'}]);
 assert.equal(onlyBlank[0].statusText,'1 条待补充');
});

test('human review displays per-photo AI observations without converting them into report issues',()=>{
 const photo={id:'photo-A',imagePath:'/real/photo-A.jpg'};
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:[photo]},analysis:{aiMode:'model',items:[],observations:[{sourceIndex:0,sourcePhotoId:'photo-A',text:'画面中可见木饰面与墙面交界'}]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.issueGroups[0].aiObservations[0],'画面中可见木饰面与墙面交界');
 assert.equal(page.data.issueGroups[0].issues.length,0);
 assert.equal(page.data.summary.aiObservationCount,1);
 assert.equal(page.data.summary.issueCount,0);
});

test('human review does not repeat identical photo observation under the AI issue evidence',()=>{
 const duplicate='画面中可见木饰面与墙面交界';
 const photo={id:'photo-A',imagePath:'/real/photo-A.jpg'};
 const issue={id:'issue-A',sourcePhotoId:'photo-A',description:'木饰面与墙面交界处存在待核实缝隙',visualEvidence:duplicate};
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:[photo]},analysis:{aiMode:'model',items:[issue],observations:[{sourceIndex:0,sourcePhotoId:'photo-A',text:` ${duplicate} `}]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.issueGroups[0].aiObservations.join('|'),duplicate);
 assert.equal(page.data.issueGroups[0].issues[0].hideVisualEvidence,true,'identical text remains visible once at photo level');
 assert.equal(page.data.summary.aiIssueCount,1);
 assert.equal(page.data.summary.aiObservationCount,1,'review summary must expose returned AI output counts');

 issue.visualEvidence='接缝处可见一段连续缝隙';
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.issueGroups[0].issues[0].hideVisualEvidence,false,'distinct evidence remains available beside the photo observation');
 const cardWxml=fs.readFileSync(path.resolve(__dirname,'../miniprogram/components/inspection-item-card/index.wxml'),'utf8');
 assert.match(cardWxml,/item\.visualEvidence && !item\.hideVisualEvidence/);
});

test('spoken labelled fields are visibly structured in review and edits persist back to the draft',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const quote='收口未平。区域 客厅电视背景墙；分类 木作；责任方 木作班组；处理建议 补胶后复查。';
 const [item]=normalizeTextItems({id:'photo-fields',voiceText:quote},[{sourceQuote:quote}]);
 const draft={sessionId:'voice-fields-session',form:{projectId:'p',projectName:'测试项目',issueDrafts:[{id:'photo-fields',imagePath:'/test/real-photo.jpg',voiceText:quote}]},analysis:{aiMode:'text',items:[item],observations:[]}};
 let savedReview;
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>draft,writeDraft(){},patchDraft(_key,patch){savedReview=patch.review;}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'voice-fields-session'});
 const reviewed=page.data.issueGroups[0].issues[0];
 for(const [field,value] of Object.entries({area:'客厅电视背景墙',category:'木作',responsiblePartyName:'木作班组',suggestion:''}))assert.equal(reviewed[field],value);
 const cardWxml=fs.readFileSync(path.resolve(__dirname,'../miniprogram/components/inspection-item-card/index.wxml'),'utf8');
 assert.match(cardWxml,/wx:if="\{\{!editable \|\| !editing\}\}"/,'structured values must be readable without entering edit mode');
 for(const field of ['area','category','responsiblePartyName'])assert.match(cardWxml,new RegExp(`item\\.${field}`),`${field} must have a labelled read-mode display`);
 page.handleItemChange({detail:{index:0,field:'area',value:'客厅电视墙'}});
 assert.equal(savedReview.items[0].area,'客厅电视墙','manual corrections must persist in the same review draft');
});

test('text-organized review exposes the exact source quote on demand without repeating it by default',()=>{
 const {component,config}=loadComponent('inspection-item-card');
 const observerEntry=Object.entries(config.observers).find(([key])=>key.split(/\s*,\s*/).includes('editable'));
 assert.ok(observerEntry,'source disclosure visibility must react when the component changes between editable and read-only');
 const observer=observerEntry[1];
 component.properties={editable:true,index:0,displayIndex:1,titleText:'',hideTitle:true};
 observer.call(component,{id:'text-item',textOrganized:true,description:'窗台收口不平',sourceQuote:'窗台收口不平。区域：次卧窗台。'});
 assert.equal(component.data.showSourceQuote,true,'a distinct source quote should be available to verify extracted fields');
 assert.equal(component.data.sourceQuoteExpanded,false,'source text stays collapsed to keep the review page concise');
 component.toggleSourceQuote();
 assert.equal(component.data.sourceQuoteExpanded,true,'the reviewer can open the source without entering edit mode');
 observer.call(component,{id:'same-text',textOrganized:true,description:'窗台收口不平。',sourceQuote:'窗台收口不平。'});
 assert.equal(component.data.showSourceQuote,false,'identical source and description must not appear twice');
 component.properties.editable=false;
 observer.call(component,{id:'read-only',textOrganized:true,description:'窗台收口不平',sourceQuote:'窗台收口不平。'});
 assert.equal(component.data.showSourceQuote,false,'internal source quotes are not exposed in read-only/report contexts');
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/components/inspection-item-card/index.wxml'),'utf8');
 assert.match(markup,/wx:if="\{\{showSourceQuote\}\}"[\s\S]*?查看原话[\s\S]*?item\.sourceQuote/);
});

test('text organization is not presented as photo recognition or as a missing visual observation',()=>{
 const photo={id:'manual-photo',imagePath:'/real/manual-photo.jpg',analysisMode:'manual',organizeText:true,voiceText:'区域：客厅电视墙；吊顶接缝处有开裂'};
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:[photo]},analysis:{aiMode:'model',items:[{id:'text-issue',sourcePhotoId:'manual-photo',description:'吊顶接缝处有开裂',area:'客厅电视墙'}],observations:[]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.summary.visionRequested,false);
 assert.equal(page.data.summary.textOrganizationRequested,true);
 assert.equal(page.data.summary.aiHasOutput,true);
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/result/index.wxml'),'utf8');
 assert.match(markup,/文字整理结果 · 待核对/);
 assert.match(markup,/summary\.visionRequested && !summary\.aiIssueCount/,'text-only work must not show a missing-photo-recognition notice');
});

test('mixed AI batch marks only photos with neither observations nor reviewable issues as empty',()=>{
 const photos=[
  {id:'photo-A',imagePath:'/real/photo-A.jpg',analysisMode:'ai'},
  {id:'photo-B',imagePath:'/real/photo-B.jpg',analysisMode:'ai'}
 ];
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:photos},analysis:{aiMode:'model',items:[{id:'issue-A',sourcePhotoId:'photo-A',description:'收口处存在可见缝隙'}],observations:[{sourceIndex:0,sourcePhotoId:'photo-A',text:'画面中可见门套与墙面交界'}]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.issueGroups[0].aiEmpty,false,'photo with a neutral observation must not be presented as empty');
 assert.equal(page.data.issueGroups[1].aiEmpty,true,'photo without AI content must be explicitly identified');
 assert.equal(page.data.issueGroups[1].issues.length,0,'an empty AI result must not synthesize a defect');
});

test('a wholly empty AI batch uses one global notice instead of repeating it for every photo',()=>{
 const photos=Array.from({length:20},(_,index)=>({id:`photo-${index}`,imagePath:`/real/photo-${index}.jpg`,analysisMode:'ai'}));
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:photos},analysis:{aiMode:'model',items:[],observations:[]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.issueGroups.length,20);
 assert.equal(page.data.summary.aiMode,'model');
 assert.equal(page.data.summary.issueCount,0);
 assert.equal(page.data.summary.aiObservationCount,0);
 assert.equal(page.data.issueGroups.some(group=>group.aiEmpty),false,'the page-level empty notice covers the full batch');
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/result/index.wxml'),'utf8');
 assert.match(markup,/AI 未识别到明确问题[\s\S]*?照片仍在，可手动添加问题/);
 assert.match(markup,/wx:if="\{\{group\.aiEmpty\}\}"[\s\S]*?未获得识别结果，可手动添加问题。/,'partial batches retain photo-specific empty feedback');
});

test('empty text organization uses the same single notice but keeps text-only recovery guidance',()=>{
 const photo={id:'text-photo',imagePath:'/real/text-photo.jpg',analysisMode:'manual',organizeText:true,voiceText:'客厅电视背景墙区域有一道划痕'};
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:[photo]},analysis:{aiMode:'empty',items:[],observations:[]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.summary.visionRequested,false);
 assert.equal(page.data.summary.textOrganizationRequested,true);
 assert.equal(page.data.summary.aiHasOutput,false);
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/result/index.wxml'),'utf8');
 assert.equal((markup.match(/class="ai-review-notice ai-review-notice--empty"/g)||[]).length,1,'all empty-result modes share one notice block');
 assert.match(markup,/AI 未从文字中整理出可核对内容/);
 assert.match(markup,/原始说明仍保留，可直接手动填写/);
 assert.match(markup,/wx:if="\{\{summary\.visionRequested && !submissionLocked\}\}"[\s\S]*?重新识图/,'only photo-recognition empty results offer photo-recognition retry');
});

test('an explicitly AI-selected photo still shows the empty-result notice when a legacy response omits aiMode',()=>{
 const photo={id:'legacy-ai-photo',imagePath:'/real/legacy-ai-photo.jpg',analysisMode:'ai'};
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:[photo]},analysis:{items:[],observations:[]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.summary.aiRequested,true);
 assert.equal(page.data.summary.aiMode,'model');
 assert.equal(page.data.summary.aiHasOutput,false);
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/result/index.wxml'),'utf8');
 assert.match(markup,/summary\.visionRequested && !summary\.aiIssueCount/,'a successful but empty legacy response must render the recovery notice');
});

test('manual review edits cannot masquerade as AI output or hide the empty-AI notice',()=>{
 const photo={id:'photo-ai',imagePath:'/real/ai-photo.jpg',analysisMode:'ai'};
 const dependencies={
  '../../../utils/inspection-draft':{readDraft:()=>({sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts:[photo]},analysis:{aiMode:'model',items:[],observations:[]},review:{items:[{id:'manual-issue',sourcePhotoId:'photo-ai',description:'人工补充的问题'}]}}),writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:p=>p.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page}=loadPage('inspection/result',dependencies,{});
 page.onLoad({sessionKey:'s'});
 assert.equal(page.data.summary.issueCount,1,'the inspector-authored issue remains present');
 assert.equal(page.data.summary.aiHasOutput,false,'human review text is not attributed to the model');
 assert.equal(page.data.issueGroups[0].aiEmpty,false,'the all-empty batch uses the single global notice');
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/result/index.wxml'),'utf8');
 assert.match(markup,/summary\.visionRequested && !summary\.aiIssueCount/,'manual issue count must not suppress the empty-AI notice');
});

test('empty AI review offers an explicit retry using a fresh task and returns only selected AI photos to capture',()=>{
 let draft={form:{issueDrafts:[
  {id:'ai-photo',imagePath:'cloud://ai.jpg',analysisMode:'ai'},
  {id:'manual-photo',imagePath:'cloud://manual.jpg',analysisMode:'manual',voiceText:'人工说明'}
 ]},review:{items:[{id:'kept',sourcePhotoId:'manual-photo',description:'人工确认'}],stalePhotoIds:['previously-stale']},taskId:'completed-old-task',analysisRequestId:'old-request'};
 let patch,navigated=0;
 const {page}=loadPage('inspection/result',{
  '../../../utils/inspection-draft':{readDraft:()=>draft,patchDraft:(_key,value)=>{patch=value;draft={...draft,...value};}}
 },{navigateBack:options=>{navigated++;assert.equal(options.delta,1);}});
 page.data.sessionKey='session-ai';
 page.retryAiRecognition();
 assert.equal(navigated,1);
 assert.equal(patch.phase,'capture');assert.equal(patch.retryRequested,true);assert.equal(patch.taskId,'');
 assert.match(patch.analysisRequestId,/^analysis-retry-/);assert.notEqual(patch.analysisRequestId,'old-request');
 assert.equal(patch.review.stale,true);
 assert.equal(JSON.stringify(patch.review.stalePhotoIds),JSON.stringify(['previously-stale','ai-photo']));
 assert.equal(JSON.stringify(patch.review.items),JSON.stringify(draft.review.items),'manual confirmed work remains in the draft');
});

test('capture consumes the one-shot AI retry request and starts one fresh analysis automatically',async()=>{
 let calls=0,stored={retryRequested:true,form:{projectId:'p',issueDrafts:[{id:'ai-photo',imagePath:'cloud://photo.jpg',analysisMode:'ai'}]}};
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{readDraft:()=>stored,patchDraft:(_key,value)=>{stored={...stored,...value};}}
 },{getRecorderManager:()=>({}),getStorageSync:()=>null});
 page.data.sessionKey='session-ai';page.initializing=false;page.restoreDraft=()=>true;page.handleAnalyze=()=>{calls++;};
 await page.onShow();
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(calls,1,'the explicit retry action starts exactly one attempt');
 assert.equal(stored.retryRequested,false,'the trigger is consumed before asynchronous analysis starts');
});

test('submitting asks before clearing unlinked blank rows and never publishes linked blank markers',async()=>{
 let modal,submitted;
 const {page}=loadPage('inspection/result',{}, {showModal:value=>{modal=value}});
 page.data.form={issueDrafts:[{id:'p'}]};page.data.sessionKey='s';page.data.submitting=false;
 page.persistReview=()=>true;page.updateIssues=items=>{page.data.issues=items};
 page.submitReviewedIssues=async items=>{submitted=items};
 page.data.issues=[{id:'blank',sourcePhotoId:'p',description:''},{id:'filled',sourcePhotoId:'p',description:'已核对'}];
 await page.handleSubmit();
 assert.equal(modal.title,'移除空白问题？');assert.equal(submitted,undefined);
 modal.success({confirm:true});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(Array.from(submitted,item=>item.id),['filled']);
 page.data.issues=[{id:'linked-blank',sourcePhotoId:'p',description:'',annotationId:'point-1',markerNumber:1}];
 submitted=undefined;await page.handleSubmit();
 assert.equal(modal.title,'有标注还没有说明');assert.equal(submitted,undefined);
});

test('manually added review issue binds to the next unused numbered annotation on the same photo',()=>{
 const {page}=loadPage('inspection/result',{},{});
 page.data.form={issueDrafts:[{id:'photo-a',annotations:[
  {id:'mark-1',type:'box',numbered:true},
  {id:'arrow-1',type:'arrow'},
  {id:'mark-2',type:'ellipse',numbered:true}
 ]}]};
 page.data.issues=[{id:'issue-existing',sourcePhotoId:'photo-a',annotationId:'mark-1',markerNumber:1,description:'已有问题'}];
 page.updateIssues=items=>{page.data.issues=items;};
 page.handleAddIssue({currentTarget:{dataset:{index:'0'}}});
 const added=page.data.issues.at(-1);
 assert.equal(added.sourcePhotoId,'photo-a');
 assert.equal(added.annotationId,'mark-2');
 assert.equal(added.markerNumber,2);
 assert.equal(added.subIssueIndex,2);
 page.handleAddIssue({currentTarget:{dataset:{index:'0'}}});
 assert.equal(page.data.issues.at(-1).annotationId,undefined,'an extra issue remains unmarked after all numbered marks are claimed');
});

test('a late analysis checks the stored input version before overwriting the current form',async()=>{
 let writes=0;
 const {page}=loadPage('inspection/create',{'../../../utils/inspection-draft':{readDraft:()=>({form:{issueDrafts:[{id:'new'}]},inputVersion:2})}},
  {getRecorderManager:()=>({}),getStorageSync:()=>false,showModal(){}});
 page.data.sessionKey='s';page.data.form={issueDrafts:[{id:'new'}]};page.pendingInputVersion=1;page.waitingForAnalysis=true;page.persistDraft=()=>{writes++;return true};
 const done=await page.completeAnalyzeSuccess({issueDrafts:[{id:'old'}]},{aiMode:'model',items:[]});
 assert.equal(done,false);assert.equal(writes,0);assert.equal(page.data.form.issueDrafts[0].id,'new');
});

test('successful AI results pass from task completion into per-photo human review in the same session',async()=>{
 const events=[];
 const draft={form:{projectId:'project-B',projectName:'项目 B',issueDrafts:[{id:'photo-B',imagePath:'/durable/photo.jpg',analysisMode:'ai'}]},inputVersion:4};
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{
   readDraft:()=>draft,
   patchDraft:(sessionKey,patch)=>{events.push(['patch',sessionKey,patch]);Object.assign(draft,patch);}
  }
 },{
  getRecorderManager:()=>({}),getStorageSync:()=>false,
  navigateTo:options=>events.push(['navigate',options.url])
 });
 page.data.sessionKey='session-B';page.data.form=draft.form;page.ownsDraft=true;page.waitingForAnalysis=true;
 page.persistDraft=()=>true;page.clearAnalyzeTaskPolling=()=>{};
 const analysis={aiMode:'model',items:[{id:'issue-B',sourcePhotoId:'photo-B',sourceIndex:0,description:'收口处有可见缝隙'}],summary:'',observations:[{sourcePhotoId:'photo-B',sourceIndex:0,text:'画面中可见木饰面与墙面交界'}]};
 const result=await page.completeAnalyzeSuccess(draft.form,analysis);
 assert.equal(result,true);
 assert.equal(events[0][0],'patch');
 assert.equal(events[0][1],'session-B');
 assert.equal(events[0][2].phase,'review');
 assert.equal(JSON.stringify(events[0][2].analysis),JSON.stringify(analysis));
 assert.equal(events[1][0],'navigate');
 assert.equal(events[1][1],'/pages/inspection/result/index?sessionKey=session-B');
 assert.equal(page.data.analyzing,false);

 const reviewDependencies={
  '../../../utils/inspection-draft':{readDraft:()=>draft,writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:photo=>photo.imagePath},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
 };
 const {page:review}=loadPage('inspection/result',reviewDependencies,{});
 review.onLoad({sessionKey:'session-B'});
 assert.equal(review.data.summary.aiIssueCount,1);
 assert.equal(review.data.summary.aiObservationCount,1);
 assert.equal(review.data.issueGroups[0].issues[0].description,'收口处有可见缝隙');
 assert.equal(review.data.issueGroups[0].aiObservations[0],'画面中可见木饰面与墙面交界');
});

test('processing choice applies only to the imported batch, not previous photos',()=>{
 const {page}=loadPage('inspection/create',{}, {getRecorderManager:()=>({})});
 page.data.form={projectId:'p',issueDrafts:[{id:'old',imagePath:'/old.jpg',analysisMode:'ai'},{id:'new1',imagePath:'/new1.jpg',analysisMode:'pending'},{id:'new2',imagePath:'/new2.jpg',analysisMode:'pending'}]};
 page.data.photoChoiceIds=['new1','new2'];page.data.photoChoiceOpen=true;page.persistDraft=()=>true;
 page.startPhotoRecognition=()=>{};
 page.choosePhotoProcessing({currentTarget:{dataset:{mode:'manual'}}});
 assert.equal(page.data.form.issueDrafts[0].analysisMode,'ai');assert.equal(page.data.form.issueDrafts[1].analysisMode,'manual');assert.equal(page.data.form.issueDrafts[2].analysisMode,'manual');
 assert.equal(page.data.photoChoiceOpen,false);
 assert.equal(page.data.nextActionLabel,'进入人工核对');
 page.data.photoChoiceIds=['new1'];
 page.choosePhotoProcessing({currentTarget:{dataset:{mode:'ai'}}});
 assert.equal(page.data.nextActionLabel,'进入人工核对');
});

test('changing one photo processing mode reuses the accessible in-app choice panel',()=>{
 let nativeSheet=0,persisted=0;
 const {page}=loadPage('inspection/create',{}, {getRecorderManager:()=>({}),showActionSheet(){nativeSheet++;}});
 page.data.form={projectId:'p',issueDrafts:[
  {id:'photo-a',imagePath:'/a.jpg',analysisMode:'manual'},
  {id:'photo-b',imagePath:'/b.jpg',analysisMode:'ai'}
 ]};
 page.chooseSinglePhotoProcessing({currentTarget:{dataset:{id:'photo-b'}}});
 assert.equal(page.data.photoChoiceOpen,true);
 assert.deepEqual(Array.from(page.data.photoChoiceIds),['photo-b']);
 page.persistDraft=()=>{persisted++;return true;};
 page.choosePhotoProcessing({currentTarget:{dataset:{mode:'manual'}}});
 assert.equal(page.data.form.issueDrafts[0].analysisMode,'manual');
 assert.equal(page.data.form.issueDrafts[1].analysisMode,'manual');
 assert.equal(nativeSheet,0,'mode selection stays within the app visual and accessibility system');
 assert.equal(persisted,1);
});

test('normalization storage failure never reports save success; retry preserves upright source and geometry together',async()=>{
 let blocked=true,navigated=0,saved,modals=[];
 const {page}=loadPage('inspection/annotate',{
  '../../../utils/inspection-draft':{readDraft:()=>({form:{issueDrafts:[{id:'p'}]}}),updateIssueDraft:(session,id,patch)=>{if(blocked)throw Error('disk full');saved=patch;return {issueDrafts:[patch]};}},
  '../../../services/inspection-media':{keepLocalFile:async()=>'/durable/rendered.png'}
 },{navigateBack(){navigated++},showModal:m=>modals.push(m),showToast(){}});
 Object.assign(page.data,{sessionKey:'s',issueId:'p',annotations:[{id:'mark'}],annotationStage:{version:2},editorReady:true});
 page.selectComponent=()=>({exportImage:async()=>'/temporary/rendered.png'});
 page.handleNormalized({detail:{path:'/durable/upright.png',originalPath:'/durable/original.jpg'}});
 assert.match(page.data.storageError,/未能暂存/);await page.handleSave();assert.equal(navigated,0);assert.match(page.data.storageError,/保存标注失败/);assert.equal(modals.length,0,'save failure stays in the shared in-page status rather than switching to a native white modal');
 blocked=false;await page.handleSave();assert.equal(navigated,1);assert.equal(page.data.storageError,'');assert.equal(saved.imagePath,'/durable/upright.png');
 assert.equal(saved.sourceOriginalImagePath,'/durable/original.jpg');assert.equal(saved.annotatedImagePath,'/durable/rendered.png');assert.equal(saved.annotationRevision,1);assert.equal(saved.annotationDirty,false);assert.equal(saved.annotations[0].id,'mark');
});

test('saved annotation survives editor return and becomes the capture-page photo preview',async()=>{
 const previousWx=global.wx,previousApp=global.getApp;
 const storage=new Map();let returned=0;
 global.wx={getStorageSync:key=>structuredClone(storage.get(key)),setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key)};
 global.getApp=()=>({globalData:{userInfo:{openId:'isolated-annotation-owner'}}});
 try {
  const draft=require('../miniprogram/utils/inspection-draft');
  draft.writeDraft('isolated-session',{projectId:'p',projectName:'隔离项目',issueDrafts:[{id:'photo-1',imagePath:'/durable/original.jpg',localImagePath:'/durable/original.jpg',annotations:[],analysisMode:'manual'}]});
  const {page:editor}=loadPage('inspection/annotate',{
   '../../../utils/inspection-draft':draft,
   '../../../services/inspection-media':{keepLocalFile:async()=>'/durable/marked.jpg'},
   '../../../services/cloud-media':{isCloudFileId:()=>false}
  },{navigateBack(){returned++;},showModal(){}});
  editor.onLoad({sessionKey:'isolated-session',issueId:'photo-1'});
  editor.handleEditorReady({detail:{width:1200,height:800,annotations:[],stage:{version:2,width:1200,height:800}}});
  editor.handleAnnotationChange({detail:[{id:'marker-1',type:'point',number:1,a:{x:.4,y:.6},b:{x:.43,y:.63}}]});
  editor.selectComponent=()=>({exportImage:async()=>'/tmp/marked.jpg'});
  await editor.handleSave();
  assert.equal(returned,1,'saving the annotation returns to the capture flow');

  const {page:capture}=loadPage('inspection/create',{'../../../utils/inspection-draft':draft},{getRecorderManager:()=>({})});
  capture.data.sessionKey='isolated-session';capture.data.form={projectId:'p',issueDrafts:[]};
  assert.equal(capture.restoreDraft(),true);
  const photo=capture.data.form.issueDrafts[0];
  assert.equal(photo.displayImagePath,'/durable/marked.jpg','capture must show the saved annotated rendition, not the unmarked original');
  assert.equal(photo.annotationCount,1);
  assert.equal(photo.annotations[0].id,'marker-1');
  const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/create/index.wxml'),'utf8');
  assert.match(markup,/class="issue-draft-card__image" src="\{\{item\.displayImagePath \|\|/);
 } finally {
  global.wx=previousWx;global.getApp=previousApp;
 }
});

test('opening a clean photo does not mark its annotation dirty or force a save confirmation',()=>{
 let navigated=0,modals=0;
 const draft={form:{issueDrafts:[{id:'photo',annotations:[{id:'saved',type:'point'}],annotationDirty:false}]}};
 const {page}=loadPage('inspection/annotate',{
  '../../../utils/inspection-draft':{readDraft:()=>draft,updateIssueDraft(){return draft.form}},
  '../../../services/inspection-media':{},
  '../../../services/cloud-media':{isCloudFileId:()=>false}
 },{navigateBack(){navigated++},showModal(){modals++}});
 page.onLoad({sessionKey:'s',issueId:'photo'});
 page.handleEditorReady({detail:{width:100,height:100,annotations:draft.form.issueDrafts[0].annotations,stage:{version:2,width:100,height:100}}});
 assert.equal(page.data.hasPendingEdits,false);
 page.handleBackTap();
 assert.equal(navigated,1);assert.equal(modals,0,'a view-only open must return directly');
});

test('a real annotation edit offers save, keep-editing or discard and restores the original marks on discard',()=>{
 let navigated=0;
 const draft={form:{issueDrafts:[{id:'photo',annotations:[],annotationDirty:false}]}};
 const {page}=loadPage('inspection/annotate',{
  '../../../utils/inspection-draft':{readDraft:()=>draft,updateIssueDraft(_s,_id,patch){Object.assign(draft.form.issueDrafts[0],patch);return draft.form}},
  '../../../services/inspection-media':{},
  '../../../services/cloud-media':{isCloudFileId:()=>false}
 },{navigateBack(){navigated++}});
 page.data.sessionKey='s';page.data.issueId='photo';
 page.handleAnnotationChange({detail:[{id:'new-mark',type:'point'}]});
 assert.equal(page.data.hasPendingEdits,true);assert.equal(draft.form.issueDrafts[0].annotationDirty,true);
 page.handleBackTap();assert.equal(page.data.leaveDialogOpen,true);assert.equal(navigated,0);
 page.closeLeaveDialog();assert.equal(page.data.leaveDialogOpen,false);assert.equal(navigated,0,'continue editing leaves the canvas open');
 page.handleBackTap();page.cancelEditsAndReturn();assert.equal(navigated,1);assert.equal(draft.form.issueDrafts[0].annotations.length,0);assert.equal(draft.form.issueDrafts[0].annotationDirty,false);
});

test('annotation exit sheet save action closes the sheet and delegates to the single save path',()=>{
 const {page}=loadPage('inspection/annotate',{},{});
 let saves=0;page.data.leaveDialogOpen=true;page.handleSave=()=>{saves++};page.saveAndReturn();
 assert.equal(page.data.leaveDialogOpen,false);assert.equal(saves,1);
 page.data.leaveDialogOpen=true;page.data.saving=true;page.saveAndReturn();
 assert.equal(page.data.leaveDialogOpen,true);assert.equal(saves,1,'a duplicate tap while saving does not dismiss or submit again');
});

test('annotation resolves a cloud-only photo for the canvas without changing the draft reference',async()=>{
 const draft={form:{issueDrafts:[{id:'photo',imagePath:'cloud://env/photo.png',annotations:[]}]}};
 const {page}=loadPage('inspection/annotate',{
  '../../../utils/inspection-draft':{readDraft:()=>draft,updateIssueDraft(){return draft.form}},
  '../../../services/cloud-media':{isCloudFileId:value=>value.startsWith('cloud://'),resolveCloudFileUrls:async ids=>({urls:{[ids[0]]:'https://temporary.example/annotate-photo.png'},failed:[]})}
 },{});
 await page.onLoad({sessionKey:'s',issueId:'photo'});
 assert.equal(page.data.imagePath,'https://temporary.example/annotate-photo.png');
 assert.equal(draft.form.issueDrafts[0].imagePath,'cloud://env/photo.png');
});

test('review rehydrates legacy cloud-only photo IDs into display URLs and keeps the draft IDs unchanged',async()=>{
 const draft={form:{projectId:'p',projectName:'项目',issueDrafts:[{id:'photo',imagePath:'cloud://env/photo.png',voiceText:''}]},analysis:{items:[]}};
 const {page}=loadPage('inspection/result',{
  '../../../utils/inspection-draft':{readDraft:()=>draft,writeDraft(){},patchDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues:items=>items,resolveIssueMedia(){},getPhotoDisplayPath:photo=>photo.imagePath},
  '../../../services/cloud-media':{isCloudFileId:value=>value.startsWith('cloud://'),resolveCloudFileUrls:async ids=>({urls:{[ids[0]]:'https://temporary.example/photo.png'},failed:[]})},
  '../../../services/inspection-media':{uploadDraftMedia:async form=>form},
  '../../../services/inspection':{},'../../../services/report':{},'../../../services/settings':{},'../../../services/user':{},
  '../../../utils/guide':{},'../../../utils/router':{}
 },{showModal(){}});
 page.onLoad({sessionKey:'s'});
 await new Promise(setImmediate);
 assert.equal(page.data.issueGroups[0].image,'https://temporary.example/photo.png');
 assert.equal(draft.form.issueDrafts[0].imagePath,'cloud://env/photo.png');
});

test('capture rehydrates legacy cloud-only photo IDs without changing stable draft paths',async()=>{
 const draft={form:{projectId:'p',issueDrafts:[{id:'photo',imagePath:'cloud://env/photo.png',voiceText:''}]}};
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{readDraft:()=>draft,writeDraft(){},patchDraft(){},extractDraftForm:value=>value.form,extractDraftReturnContext:()=>null},
  '../../../services/cloud-media':{isCloudFileId:value=>value.startsWith('cloud://'),resolveCloudFileUrls:async ids=>({urls:{[ids[0]]:'https://temporary.example/capture-photo.png'},failed:[]})}
 },{getRecorderManager:()=>({})});
 page.data.sessionKey='s';page.data.form={projectId:'p',issueDrafts:[]};
 assert.equal(page.restoreDraft(),true);
 await new Promise(setImmediate);
 assert.equal(page.data.form.issueDrafts[0].displayImagePath,'https://temporary.example/capture-photo.png');
 assert.equal(page.data.form.issueDrafts[0].imagePath,'cloud://env/photo.png');
});

test('review keeps legacy per-photo notes readable without showing a new per-photo supplement action',()=>{
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/inspection/result/index.wxml'),'utf8');
 assert.match(markup,/现场说明/,'previously saved notes remain readable');
 assert.doesNotMatch(markup,/补充照片说明|添加补充|toggleCaptionEditing|handleCaptionInput/,'new inspections should not expose a duplicate per-photo free-text field');
 assert.match(markup,/添加问题/,'photo-level content remains organized as actual issue records');
});

test('opening an online report never creates or polls a PDF task',async()=>{
 const report={_id:'report-online',projectName:'测试项目',items:[],photos:[],status:'pdf_generating',pdfFileId:'legacy-pdf'};
 const {page}=loadPage('report/detail',{
  '../../../services/report':{
   getReportDetail:async()=>report,
   buildReportData:async()=>report
  },
  '../../../services/cloud-media':{isCloudFileId:value=>String(value||'').startsWith('cloud://'),resolveCloudFileUrls:async()=>({urls:{},failed:[]})},
  '../../../utils/format':{mapResponsiblePartyText:value=>value||'',formatDateTime:()=>'',usesEditorialTypeface:()=>false},
  '../../../utils/report-identity':{buildReportNo:()=> 'CB-TEST'},
  '../../../utils/system':{getWindowInfo:()=>({windowWidth:375})},
  '../../../utils/guide':{markGuideStep(){}},
  '../../../utils/router':{decodeReturnContext:()=>null,returnToContext(){}}
 },{hideShareMenu(){},showShareMenu(){},showToast(){},getWindowInfo:()=>({windowWidth:375})});
 page.data.reportId='report-online';
 await page.onShow();
 await new Promise(setImmediate);
 assert.equal(page.data.report._id,'report-online');
 assert.equal(page.data.report.pdfFileId,'legacy-pdf','legacy references remain readable without activating PDF workflow');
 assert.equal(page.generatePdf,undefined);
 assert.equal(page.openPdf,undefined);
 assert.equal(page.savePdfToLocal,undefined);
 assert.equal(page.pollPdfTaskStatus,undefined);
 assert.equal(page.data.pdfSubmitting,undefined);
});

test('publication number stays fixed and report numbering remains bound to photo annotations',()=>{
 const {context}=loadPage('report/detail');
 const base={_id:'report-abcd',publishedAt:1700000000000,createdAt:1699000000000};
 assert.equal(context.buildReportNo({...base,generatedAt:1701000000000}),context.buildReportNo({...base,generatedAt:1702000000000}));
 const display=context.buildReportDisplayState({...base,status:'pdf_generating',pdfFileId:'legacy-pdf'});
 assert.equal(display.status,'pdf_generating','historical backend fields remain readable but do not drive PDF actions');
 assert.equal(display.pdfFileId,'legacy-pdf','historical report file references are preserved');
 const zero=context.buildIssueGroups([],[{id:'photo',imagePath:'cloud://original',annotatedImagePath:'cloud://marked'}]);
 assert.equal(zero[0].image,'cloud://original','zero-issue report must not show an orphan numbered annotation');
 assert.equal(zero[0].groupTitle,'照片 01','zero-issue report must keep the photo sequence independent from issue count');
 assert.equal(zero[0].groupStatus,'未记录问题');
 const linked=context.buildIssueGroups([{id:'issue',sourcePhotoId:'photo',annotationId:'point-2',description:'已确认问题',markerNumber:2,subIssueIndex:2}],[{id:'photo',imagePath:'cloud://original',annotatedImagePath:'cloud://marked',annotations:[{id:'point-2',type:'point',a:{x:.25,y:.75},b:{x:.3,y:.8}}]}]);
 assert.equal(linked[0].image,'cloud://marked','a linked issue should keep the annotated report image');
 assert.equal(linked[0].groupTitle,'照片 01','issue-bearing photo keeps the photo sequence numbering');
 assert.equal(linked[0].groupStatus,'1 项问题');
 assert.equal(linked[0].issues[0].displayNo,'2.');
 assert.equal(linked[0].issues[0].markerLabel,'照片标注 2');
  assert.equal(linked[0].mappingText,'照片标注号与下方同号问题一一对应');
 assert.equal(JSON.stringify(linked[0].markers),JSON.stringify([{key:'issue',number:2,x:.25,y:.75,left:'25%',top:'75%'}]));
 const threeMarkers=context.buildIssueGroups([
  {id:'issue-1',sourcePhotoId:'photo-many',annotationId:'p1',description:'窗台收口待处理',markerNumber:1,subIssueIndex:1},
  {id:'issue-2',sourcePhotoId:'photo-many',annotationId:'p2',description:'密封胶不连续',markerNumber:2,subIssueIndex:2},
  {id:'issue-3',sourcePhotoId:'photo-many',annotationId:'p3',description:'墙面有污染',markerNumber:3,subIssueIndex:3}
 ],[{id:'photo-many',imagePath:'cloud://original',annotatedImagePath:'cloud://marked',annotations:[
  {id:'p1',type:'point',a:{x:.15,y:.25},b:{x:.18,y:.28}},
  {id:'p2',type:'point',a:{x:.5,y:.55},b:{x:.53,y:.58}},
  {id:'p3',type:'point',a:{x:.82,y:.7},b:{x:.85,y:.73}}
 ]}]);
 assert.equal(JSON.stringify(threeMarkers[0].issues.map(issue=>[issue.displayNo,issue.markerLabel,issue.markerPoint.x,issue.markerPoint.y])),JSON.stringify([
  ['1.','照片标注 1',.15,.25],['2.','照片标注 2',.5,.55],['3.','照片标注 3',.82,.7]
 ]));
 assert.equal(JSON.stringify(threeMarkers[0].markers.map(marker=>marker.number)),JSON.stringify([1,2,3]));
 const reordered=context.buildIssueGroups([
  {id:'issue-a-2',sourcePhotoId:'photo-a',annotationId:'a-2',description:'A 图第二处',markerNumber:2,subIssueIndex:2},
  {id:'issue-b-1',sourcePhotoId:'photo-b',annotationId:'b-1',description:'B 图第一处',markerNumber:1,subIssueIndex:1},
  {id:'issue-a-1',sourcePhotoId:'photo-a',annotationId:'a-1',description:'A 图第一处',markerNumber:1,subIssueIndex:1}
 ],[
  {id:'photo-b',sourceIndex:0,imagePath:'cloud://b',annotations:[{id:'b-1',type:'point',a:{x:.8,y:.2}}]},
  {id:'photo-a',sourceIndex:1,imagePath:'cloud://a',annotations:[{id:'a-1',type:'point',a:{x:.1,y:.3}},{id:'a-2',type:'point',a:{x:.4,y:.6}}]}
 ]);
 assert.equal(JSON.stringify(reordered.map(group=>group.key)),JSON.stringify(['photo-b','photo-a']),'report order follows photo order, not issue arrival order');
 assert.equal(JSON.stringify(reordered.map(group=>group.issues.map(issue=>[issue.description,issue.displayNo,issue.markerPoint?.x,issue.markerPoint?.y]))),JSON.stringify([
  [['B 图第一处','1.',.8,.2]],
  [['A 图第一处','1.',.1,.3],['A 图第二处','2.',.4,.6]]
 ]),'stable photo and annotation IDs keep each issue paired with the right numbered mark after reorder');
 const mixed=context.buildIssueGroups([
  {id:'marked',sourcePhotoId:'photo',description:'有图上位置',markerNumber:1,subIssueIndex:1},
  {id:'unmarked',sourcePhotoId:'photo',description:'仅文字问题',markerNumber:0,subIssueIndex:2}
 ],[{id:'photo',imagePath:'cloud://original',annotatedImagePath:'cloud://marked'}]);
 assert.equal(mixed[0].mappingText,'问题按本照片内顺序编号；未标注位置或缺少坐标的问题会明确说明');
 assert.equal(mixed[0].issues[0].markerLabel,'照片标注 1 · 位置数据缺失');
 assert.equal(mixed[0].issues[1].markerLabel,'未标注位置');
 const legacyAmbiguous=context.buildIssueGroups([{description:'历史来源不明确'}],[{imagePath:'cloud://same'},{imagePath:'cloud://same'}]);
 assert.equal(legacyAmbiguous.filter(group=>group.issues.length).length,1,'ambiguous legacy image paths must not silently attach to both photos');
 assert.match(legacyAmbiguous.find(group=>group.issues.length).groupTitle,/来源待确认/,'ambiguous legacy grouping must be visible to the reviewer');
});

test('report hides a legacy photo caption that repeats issue text but retains distinct photo context',()=>{
 const {context}=loadPage('report/detail');
 const repeated=context.buildIssueGroups([
  {id:'issue-1',sourcePhotoId:'photo-1',description:'墙面收口处存在明显缝隙，需要现场复核。',subIssueIndex:1}
 ],[{id:'photo-1',imagePath:'cloud://photo-1',caption:'墙面收口处存在明显缝隙，需要现场复核。区域：客厅。'}]);
 assert.equal(repeated[0].caption,'','a transcript that already contains the issue must not render twice');
 const distinct=context.buildIssueGroups([
  {id:'issue-2',sourcePhotoId:'photo-2',description:'墙角需要补胶。',subIssueIndex:1}
 ],[{id:'photo-2',imagePath:'cloud://photo-2',caption:'现场补充：照片拍摄时室内照明不足。'}]);
 assert.equal(distinct[0].caption,'现场补充：照片拍摄时室内照明不足。','a distinct photo-level note remains in the report');
});

test('report identity omits duplicate roles and combines repeated contact numbers',()=>{
 const {context}=loadPage('report/detail');
 const same={
  _id:'report-identity',publishedAt:Date.UTC(2026,8,29),companyName:'示例市示例家具有限公司',
  companyPhone:'13900000000',inspectorName:'张工',inspectorPhone:'13900000000',
  publisherName:'张工',publisherPhone:'13900000000',projectAddress:'示例市示例区示例路36号',companyAddress:'示例市示例区示例路36号',
  photos:[],items:[]
 };
 const display=context.buildReportDisplayState(same);
 assert.deepEqual(Array.from(display.identityRows,row=>row.label),['报告编号','巡查人 / 发布人','项目位置']);
 assert.deepEqual(Array.from(display.contactEntries,row=>[row.label,row.phone]),[['统一联系电话','13900000000']]);
 // 发布人用另一个号码，才能验证「同号合并、异号分行」这条规则仍然生效。
 const distinct=context.buildReportDisplayState({...same,publisherName:'周工',publisherPhone:'13900000001'});
 assert.deepEqual(Array.from(distinct.identityRows,row=>row.label),['报告编号','巡查人','项目位置','报告发布人']);
 assert.deepEqual(Array.from(distinct.contactEntries,row=>[row.label,row.phone]),[
  ['统一联系电话','13900000000'],['发布人','13900000001']
 ]);
 const differentAddresses=context.buildReportDisplayState({...same,projectAddress:'示例市示例区示例路38号'});
 assert.deepEqual(Array.from(differentAddresses.identityRows,row=>row.label),['报告编号','巡查人 / 发布人','项目位置','单位地址']);
 assert.equal(differentAddresses.identityRows[3].value,'示例市示例区示例路36号');
 const missing=context.buildReportDisplayState({_id:'report-minimal',photos:[],items:[]});
 assert.deepEqual(Array.from(missing.identityRows,row=>row.label),['报告编号']);
 assert.deepEqual(Array.from(missing.contactEntries),[]);
});

test('report hides legacy generated count boilerplate but preserves authored summaries',()=>{
 const {context}=loadPage('report/detail');
 const base={_id:'report-summary',photos:[],items:[{description:'已确认问题'}]};
 const legacy=context.buildReportDisplayState({...base,summary:'本次记录 1 个问题项。记录仅覆盖所拍照片与现场说明，不代表工程验收合格。'});
 assert.equal(legacy.conclusion,'本次已确认 1 项问题。');
 assert.equal(legacy.summary,'');
 const countOnly=context.buildReportDisplayState({...base,summary:'本次记录 1 个问题项。'});
 assert.equal(countOnly.summary,'');
 const authored=context.buildReportDisplayState({...base,summarySource:'inspector',summary:'本次记录 1 个问题项。记录仅覆盖所拍照片与现场说明，不代表工程验收合格。'});
 assert.equal(authored.summary,'本次记录 1 个问题项。记录仅覆盖所拍照片与现场说明，不代表工程验收合格。');
 const useful=context.buildReportDisplayState({...base,summary:'木饰面收口与插座面板周边需复核。'});
 assert.equal(useful.summary,'木饰面收口与插座面板周边需复核。');
});

test('project detail opens the native picker first, then creates a project-bound photo draft before navigation',async()=>{
 let pickerCalled=false,written=null;const navigated=[];
 const {page}=loadPage('project/detail',{
  '../../../services/project':{},'../../../utils/format':{},
  '../../../utils/router':{encodeReturnContext:()=> 'return-context'},
  '../../../utils/inspection-draft':{listDrafts:()=>[],writeDraft:(key,form,context)=>{written={key,form,context};}},
  '../../../services/inspection-media':{keepLocalFile:async path=>`/persistent/${path.split('/').pop()}`},
  '../../../utils/inspection-model':{identity:prefix=>`${prefix}-stable`}
 },{
  chooseMedia(options){pickerCalled=true;assert.equal(navigated.length,0,'do not navigate while the native picker is open');options.success({tempFiles:[{tempFilePath:'/tmp/site.jpg'}]});},
  navigateTo:options=>navigated.push(options.url),showToast(){}
 });
 Object.assign(page.data,{loading:false,loadError:'',projectId:'project-b',project:{_id:'project-b',name:'项目 B'}});
 page.goInspectionCreate();assert.equal(page.data.captureChoiceOpen,true);
 const work=page.chooseCaptureSource({currentTarget:{dataset:{sourceType:'camera'}}});
 assert.equal(pickerCalled,true,'camera is invoked directly from the project page');
 assert.equal(navigated.length,0);
 await work;
 assert.equal(written.form.projectId,'project-b');
 assert.equal(written.form.issueDrafts[0].imagePath,'/persistent/site.jpg');
 assert.equal(written.form.issueDrafts[0].id,'photo-stable');
 assert.equal(navigated.length,1);
 assert.match(navigated[0],/projectId=project-b/);
 assert.match(navigated[0],/sessionKey=inspection-create-stable/);
 assert.doesNotMatch(navigated[0],/captureSource=/);
});

test('canceling or failing the direct project-page picker does not create a blank draft or navigate',async()=>{
 for(const failure of [{errMsg:'chooseMedia:fail cancel'},{errMsg:'chooseMedia:fail permission denied'}]){
  let writes=0,navigations=0;
  const {page}=loadPage('project/detail',{
   '../../../services/project':{},'../../../utils/format':{},'../../../utils/router':{encodeReturnContext:()=>''},
   '../../../utils/inspection-draft':{listDrafts:()=>[],writeDraft(){writes++;}},
   '../../../services/inspection-media':{keepLocalFile:async path=>path},'../../../utils/inspection-model':{identity:()=> 'id'}
  },{chooseMedia:options=>options.fail(failure),showToast(){},showModal(){},navigateTo(){navigations++;}});
  Object.assign(page.data,{loading:false,loadError:'',projectId:'project-b',project:{_id:'project-b',name:'B'}});
  await page.chooseCaptureSource({currentTarget:{dataset:{sourceType:'album'}}});
  assert.equal(writes,0);assert.equal(navigations,0);assert.equal(page.data.capturePicking,false);
 }
});

test('PDF grouping marks unmatched legacy source instead of guessing a photo',()=>{
 const {groupItemsByImage}=require('../report-pdf-service/src/report-template');
 const groups=groupItemsByImage([{description:'历史来源不明确'}],[{imagePath:'cloud://same'},{imagePath:'cloud://same'}]);
 const unresolved=groups.find(group=>group.items.length);
 assert.equal(unresolved.sourceAmbiguous,true);
 assert.match(require('../report-pdf-service/src/report-template').buildReportHtml({photos:[],items:[{description:'历史来源不明确'}]}),/来源待确认/);
});

test('report image viewer opens the issue-linked full photo, supports issue selection, and closes cleanly',async()=>{
 let imageInfoCalls=0;
 const {page}=loadPage('report/detail',{}, {
  getWindowInfo:()=>({windowWidth:375,windowHeight:800,statusBarHeight:24}),
  getMenuButtonBoundingClientRect:()=>({top:28,height:32,left:260}),
  getImageInfo:options=>{imageInfoCalls++;options.success({width:1200,height:800});},
  showToast(){}
 });
 const group={key:'photo-a',groupTitle:'照片 01',image:'https://images.example/photo.jpg',sourceWidth:1200,sourceHeight:800,issues:[{viewerKey:'issue-a',id:'issue-a',displayNo:'1.',description:'收口未完成',markerNumber:1,markerPoint:{left:'25%',top:'50%'}}]};
 page.data.report={issueGroups:[group]};
 page.handlePreviewImage({currentTarget:{dataset:{index:'0'}}});
 await new Promise(setImmediate);
 assert.equal(imageInfoCalls,0,'opening a resolved report photo must not wait for another image metadata request');
 assert.equal(page.data.previewGroup.groupTitle,'照片 01');
 assert.equal(page.data.previewGroup.viewerWidth,375);
 assert.equal(page.data.previewGroup.viewerHeight,250);
 assert.equal(page.data.previewGroup.activeIssueId,'issue-a');
 assert.equal(page.data.viewerStatusBarHeight,24);
 assert.equal(page.data.viewerNavHeight,44);
 assert.equal(page.data.viewerCapsuleSafeWidth,131);
 page.handleViewerIssueTap({currentTarget:{dataset:{id:'issue-b'}}});
 assert.equal(page.data.previewGroup.activeIssueId,'issue-b');
 page.closeImageViewer();assert.equal(page.data.previewGroup,null);
});

test('report image viewer measures the resolved display image when the source is a cloud file ID',async()=>{
 let requestedSource='';
 const {page}=loadPage('report/detail',{}, {
  getWindowInfo:()=>({windowWidth:375,windowHeight:800,statusBarHeight:24}),
  getImageInfo:options=>{requestedSource=options.src;options.success({width:900,height:1200});},
  showToast(){}
 });
 const group={key:'photo-cloud',groupTitle:'照片 02',image:'https://images.example/resolved-photo.jpg',originalImage:'cloud://env.bucket/photo.jpg',issues:[]};
 page.data.report={issueGroups:[group]};
 page.handlePreviewImage({currentTarget:{dataset:{index:'0'}}});
 await new Promise(setImmediate);
 assert.equal(requestedSource,group.image,'image metadata lookup must use the same resolved URL rendered by the report');
 assert.equal(page.data.previewGroup.groupTitle,'照片 02');
 assert.equal(page.data.previewGroup.viewerWidth,375);
 assert.equal(page.data.previewGroup.viewerHeight,500);
 assert.equal(page.data.viewerStageHeight,668,'portrait photos use the full remaining viewer height, not a fixed half-screen area');
});

test('report portrait and landscape thumbnails keep natural aspect and marker positions inside the image',async()=>{
 const {page}=loadPage('report/detail',{
  '../../../services/cloud-media':{isCloudFileId:()=>false,resolveCloudFileUrls:async()=>({urls:{}})},
  '../../../utils/system':{getWindowInfo:()=>({windowWidth:375,windowHeight:800})}
 },{
  getImageInfo:options=>options.success(options.src.includes('portrait')?{width:800,height:1067}:{width:1600,height:900})
 });
 page.reportPreviewGeneration=1;
 const report={_id:'report-layout',issueGroups:[
  {key:'portrait',image:'portrait-marked.jpg',originalImage:'portrait.jpg',markers:[{number:1,x:.5,y:.5}]},
  {key:'landscape',image:'landscape-marked.jpg',originalImage:'landscape.jpg',markers:[]}
 ]};
 page.data.report=report;
 await page.resolveReportPreviewMedia(1,report);
 const [portrait,landscape]=page.data.report.issueGroups;
 assert.ok(portrait.thumbnailHeight>landscape.thumbnailHeight,'portrait evidence should retain a taller thumbnail');
 assert.equal(portrait.thumbnailHeight,Math.round(339*1.25*750/375),'portrait preview is bounded; aspectFit keeps the full image without cropping');
 assert.equal(landscape.thumbnailHeight,Math.round(339*900/1600*750/375));
 assert.equal(portrait.markers[0].left,'50%');
 assert.equal(portrait.markers[0].top,'50%');
 assert.equal(portrait.sourceWidth,800);
 assert.equal(portrait.sourceHeight,1067);
 assert.equal(portrait.originalImage,'portrait.jpg','thumbnail uses the source photo so report markers remain legible at phone size');
 assert.equal(portrait.image,'portrait-marked.jpg','full-screen viewer keeps the exported annotated image');
});

test('online report preserves stable photo IDs when positional aliases collide',()=>{
 const {context}=loadPage('report/detail',{},{});
 const groups=context.buildIssueGroups([
  {sourcePhotoId:'photo-1',description:'第一张照片的问题'}
 ],[
  {id:'photo-1',imagePath:'cloud://first'},
  {id:'photo-2',imagePath:'cloud://second'}
 ]);
 assert.equal(groups.length,2);
 assert.equal(groups[0].issues.length,1);
 assert.equal(groups[0].image,'cloud://first');
 assert.equal(groups[1].issues.length,0);
});

test('manual photo points bind one-to-one with spoken clauses and survive media resolution',()=>{
 const {buildManualReviewItems,resolveIssueMedia}=require('../miniprogram/utils/inspection-model');
 const photo={id:'photo-a',voiceText:'窗台收口待处理；胶缝有断点；墙面有污染',annotations:[
  {id:'point-a',type:'point',a:{x:.1,y:.2},b:{x:.14,y:.24}},
  {id:'point-b',type:'point',a:{x:.4,y:.5},b:{x:.45,y:.55}},
  {id:'point-c',type:'point',a:{x:.8,y:.7},b:{x:.85,y:.76}},
  {id:'box-a',type:'box',a:{x:.1,y:.1},b:{x:.2,y:.2}}
 ]};
 const issues=buildManualReviewItems([photo]);
 assert.equal(JSON.stringify(issues.map(({description,annotationId,markerNumber,sourcePhotoId})=>[description,annotationId,markerNumber,sourcePhotoId])),JSON.stringify([
  ['窗台收口待处理','point-a',1,'photo-a'],
  ['胶缝有断点','point-b',2,'photo-a'],
  ['墙面有污染','point-c',3,'photo-a']
 ]));
 const resolved=resolveIssueMedia(issues,[{...photo,imagePath:'cloud://env/inspection-images/user/owner/a.jpeg',annotatedImagePath:'cloud://env/inspection-annotated-images/user/owner/a.png'}]);
 assert.equal(JSON.stringify(resolved.map(item=>[item.annotationId,item.markerNumber,item.images[0],item.annotatedImages[0]])),JSON.stringify([
  ['point-a',1,'cloud://env/inspection-images/user/owner/a.jpeg','cloud://env/inspection-annotated-images/user/owner/a.png'],
  ['point-b',2,'cloud://env/inspection-images/user/owner/a.jpeg','cloud://env/inspection-annotated-images/user/owner/a.png'],
  ['point-c',3,'cloud://env/inspection-images/user/owner/a.jpeg','cloud://env/inspection-annotated-images/user/owner/a.png']
 ]));
});

test('read-only published report builds the same 1/2/3 marker-to-description groups as the client page',async()=>{
 const {harness}=require('./cloud-harness.cjs');
 const h=harness();
 h.table('projects').set('project-a',{_id:'project-a',name:'隔离标注验收',address:'测试位置',ownerOpenId:'owner',deleted:false});
 const photo={id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/a.jpeg',annotatedImagePath:'cloud://env/inspection-annotated-images/user/owner/a.png',voiceText:'窗台收口待处理；胶缝有断点；墙面有污染',annotations:[
  {id:'point-a',type:'point',a:{x:.1,y:.2},b:{x:.14,y:.24}},
  {id:'point-b',type:'point',a:{x:.4,y:.5},b:{x:.45,y:.55}},
  {id:'point-c',type:'point',a:{x:.8,y:.7},b:{x:.85,y:.76}}
 ]};
 const {buildManualReviewItems}=require('../miniprogram/utils/inspection-model');
 const inspection=await h.load('inspection')({action:'confirm',payload:{requestId:'client-page-marker-flow',form:{projectId:'project-a',title:'标注与问题对应',issueDrafts:[photo]},items:buildManualReviewItems([photo])}});
 const report=h.load('report'),built=await report({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 const published=await report({action:'save',payload:{...built.data,requestId:'client-page-marker-publish'}});
 h.as('recipient');
 const shared=await report({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
 const {context}=loadPage('report/detail',{},{});
 const groups=context.buildIssueGroups(shared.data.items,shared.data.photos);
 assert.equal(groups.length,1);
 assert.equal(groups[0].groupTitle,'照片 01');
 assert.ok(groups[0].annotatedImage);
 assert.equal(groups[0].image,groups[0].annotatedImage);
 assert.equal(JSON.stringify(groups[0].markers.map(marker=>[marker.number,marker.x,marker.y])),JSON.stringify([
  [1,.1,.2],[2,.4,.5],[3,.8,.7]
 ]));
 assert.equal(JSON.stringify(groups[0].issues.map(issue=>[issue.displayNo,issue.markerLabel,issue.description])),JSON.stringify([
  ['1.','照片标注 1','窗台收口待处理'],
  ['2.','照片标注 2','胶缝有断点'],
  ['3.','照片标注 3','墙面有污染']
 ]));
});

test('manual review preserves stable photo IDs when positional aliases collide',()=>{
 const {context}=loadPage('inspection/result',{},{});
 const groups=context.buildIssueGroups([
  {sourcePhotoId:'photo-1',description:'第一张照片的问题'}
 ],[
  {id:'photo-1',imagePath:'cloud://first'},
  {id:'photo-2',imagePath:'cloud://second'}
 ]);
 assert.equal(groups.length,2);
 assert.equal(groups[0].issues.length,1);
 assert.equal(groups[0].image,'cloud://first');
 assert.equal(groups[1].issues.length,0);
});

test('manual review tells the truth about mixed marked and unmarked issues',()=>{
 const {context}=loadPage('inspection/result',{},{});
 const groups=context.buildIssueGroups([
  {id:'marked',sourcePhotoId:'photo',description:'带位置',markerNumber:1,subIssueIndex:1},
  {id:'unmarked',sourcePhotoId:'photo',description:'无位置',markerNumber:0,subIssueIndex:2}
 ],[{id:'photo',imagePath:'local.jpg'}]);
 assert.equal(groups[0].mappingText,'问题按本照片内顺序编号；未标注位置的问题没有照片编号');
 assert.equal(Array.from(groups[0].issues,issue=>issue.markerLabel).join('|'),'照片标注 1|未标注位置');
});

test('manual review does not leave an orphaned photo marker when deleting a linked issue',()=>{
 let modal;
 const {page}=loadPage('inspection/result',{}, {showModal:value=>{modal=value}});
 page.data.submissionLocked=false;
 page.data.issues=[{id:'issue-1',markerNumber:2,annotationId:'marker-2',description:'有照片标注的问题'}];
 page.handleDeleteIssue({currentTarget:{dataset:{index:0}}});
 assert.equal(modal.title,'这条问题有照片标注');
 assert.match(modal.content,/返回照片删除或调整标注/);
});

test('uploaded company logo is persisted immediately without silently saving other dirty fields',async()=>{
 let savedPayload,toast;
 const {page}=loadPage('settings',{
  '../../utils/system':{getWindowInfo:()=>({windowHeight:800})},
  '../../services/settings':{getSettings:async()=>({}),saveSettings:async payload=>{savedPayload=payload}},
  '../../services/cloud':{uploadUserFile:async()=> 'cloud://env/logos/logo.png'},
  '../../services/user':{getCurrentUser:async()=>({openId:'owner'}),updateProfile:async()=>{}},
  '../../utils/guide':{markGuideStep(){}},
  '../../utils/coach':{isCoachStep:()=>false,moveCoach(){},stopCoach(){},buildCoachTip:()=>({})}
 },{showLoading(){},hideLoading(){},showToast:value=>{toast=value},showModal(){}});
 page.setData=function(patch){for(const [key,value] of Object.entries(patch)){if(key.startsWith('form.'))this.data.form[key.slice(5)]=value;else this.data[key]=value;}};
 page.savedCompany={companyName:'已保存公司',companyPhone:'021-00000000',companyAddress:'杭州'};
 Object.assign(page.data.form,{companyName:'尚未保存的新公司名',companyPhone:'13800000000',companyAddress:'上海'});
 await page.handleLogoChange({detail:'/tmp/company-logo.png'});
 assert.equal(savedPayload.logoFileId,'cloud://env/logos/logo.png');
 assert.equal(savedPayload.companyName,'已保存公司');
 assert.equal(savedPayload.companyPhone,'021-00000000');
 assert.equal(savedPayload.companyAddress,'杭州');
 assert.equal('reportPdfEngine' in savedPayload,false,'company profile no longer configures a second PDF deliverable');
 assert.equal('reportPdfServiceUrl' in savedPayload,false,'the online-report-only client does not persist a PDF service URL');
 assert.equal(page.data.form.logoFileId,'cloud://env/logos/logo.png');
 assert.equal(page.data.form.logoPreview,'/tmp/company-logo.png');
  assert.equal(toast.title,'LOGO 已保存');
});

test('settings reopens a saved cloud logo through a display URL without replacing its stable file ID',async()=>{
 const {page}=loadPage('settings',{
  '../../utils/system':{getWindowInfo:()=>({windowHeight:800})},
  '../../services/settings':{getSettings:async()=>({companyName:'木作事务所',logoFileId:'cloud://owner/logo.png'})},
  '../../services/cloud':{},
  '../../services/user':{getCurrentUser:async()=>({openId:'owner',nickname:'陈工'})},
  '../../utils/guide':{markGuideStep(){}},
  '../../utils/coach':{isCoachStep:()=>false,moveCoach(){},stopCoach(){},buildCoachTip:()=>({})},
  '../../services/cloud-media':{isCloudFileId:value=>value.startsWith('cloud://'),resolveCloudFileUrls:async ids=>({urls:{[ids[0]]:'https://temporary.example/logo.png'},failed:[]})}
 },{});
 await page.loadSettings();
 assert.equal(page.data.form.logoFileId,'cloud://owner/logo.png');
 assert.equal(page.data.form.logoPreview,'https://temporary.example/logo.png');
 assert.equal(page.data.form.logoPreviewError,false);
});

test('an older settings request cannot clear the loading state of a newer retry',async()=>{
 const settings=[],users=[];
 const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
 settings.push(deferred(),deferred());users.push(deferred(),deferred());
 let settingIndex=0,userIndex=0;
 const {page}=loadPage('settings',{
  '../../utils/system':{getWindowInfo:()=>({windowHeight:800})},
  '../../services/settings':{getSettings:()=>settings[settingIndex++].promise},
  '../../services/user':{getCurrentUser:()=>users[userIndex++].promise},
  '../../services/cloud':{},
  '../../utils/guide':{markGuideStep(){}},
  '../../utils/coach':{isCoachStep:()=>false,moveCoach(){},stopCoach(){},buildCoachTip:()=>({})}
 },{});
 const oldLoad=page.loadSettings();
 const retry=page.loadSettings();
 settings[0].resolve({companyName:'旧请求'});users[0].resolve({openId:'owner'});
 await oldLoad;
 assert.equal(page.data.loading,true,'the superseded request must not hide the newer retry spinner');
 settings[1].resolve({companyName:'最新资料'});users[1].resolve({openId:'owner'});
 await retry;
 assert.equal(page.data.loading,false);
 assert.equal(page.data.form.companyName,'最新资料');
});

test('manual review freezes a complete preview of company and inspector contact fields',async()=>{
 const {page}=loadPage('inspection/result',{
  '../../../services/inspection':{confirmInspection:async()=>({})},
  '../../../services/report':{buildReportData:async()=>({}),saveReport:async()=>({})},
  '../../../utils/inspection-draft':{readDraft:()=>({}),patchDraft(){},writeDraft(){},finishDraft(){}},
  '../../../utils/inspection-model':{identity(){},bindIssues(){return []},resolveIssueMedia(){},getPhotoDisplayPath(){}},
  '../../../services/inspection-media':{uploadDraftMedia:async()=>({})},
  '../../../utils/router':{encodeReturnContext(){},returnToContext(){}},
  '../../../utils/guide':{markGuideStep(){}},
  '../../../utils/format':{toChineseSectionNumber(){}},
  '../../../services/settings':{getSettings:async()=>({companyName:'木作事务所',companyPhone:'010-00000002',companyAddress:'上海市测试路 1 号',logoFileId:'cloud://env/logo.png'})},
  '../../../services/user':{getCurrentUser:async()=>({nickname:'陈工',phone:'13800000000'})},
  '../../../services/cloud-media':{isCloudFileId:value=>value.startsWith('cloud://'),resolveCloudFileUrls:async()=>({urls:{'cloud://env/logo.png':'https://temporary.example/logo.png'},failed:[]})}
 },{});
 await page.onShow();
 assert.equal(page.data.reportIdentity.companyName,'木作事务所');
 assert.equal(page.data.reportIdentity.companyPhone,'010-00000002');
 assert.equal(page.data.reportIdentity.companyAddress,'上海市测试路 1 号');
 assert.equal(page.data.reportIdentity.inspectorName,'陈工');
 assert.equal(page.data.reportIdentity.inspectorPhone,'13800000000');
 assert.equal(page.data.reportIdentity.logoPreviewUrl,'https://temporary.example/logo.png');
});

test('settings warns before discarding unsaved report identity fields',()=>{
 let modal,navigated=0;
 const {page}=loadPage('settings',{
  '../../utils/system':{getWindowInfo:()=>({windowHeight:800})},
  '../../services/settings':{},'../../services/cloud':{},'../../services/user':{},
  '../../utils/guide':{markGuideStep(){}},
  '../../utils/coach':{isCoachStep:()=>false,moveCoach(){},stopCoach(){},buildCoachTip:()=>({})}
 },{showModal:value=>{modal=value},navigateBack(){navigated++}});
 page.data.dirty=true;
 page.handleBackTap();
 assert.equal(navigated,0);
 assert.equal(modal.title,'尚未保存资料');
 modal.success({confirm:true});
 assert.equal(navigated,0,'continue editing must stay on the form');
 modal.success({confirm:false});
 assert.equal(navigated,1,'discard explicitly returns to the previous page');
});

test('logo permission denial offers settings recovery while keeping upload optional',async()=>{
 let modal,opened=0;
 const {component}=loadComponent('logo-uploader',{
  '../../utils/privacy':{requirePrivacy:async()=>true}
 },{
  chooseImage(options){options.fail({errMsg:'chooseImage:fail auth deny'})},
  showModal(value){modal=value},
  openSetting(){opened++}
 });
 await component.chooseLogo();
 assert.equal(modal.title,'需要照片权限');
 assert.match(modal.content,/先不上传 LOGO/);
 modal.success({confirm:true});
 assert.equal(opened,1);
});

test('welcome v2 only remembers consent after identity initialization succeeds and supports retry',async()=>{
 let attempts=0,switched=0;const stored={};
 const {page}=loadPage('welcome',{}, {
  setStorageSync(key,value){stored[key]=value},
  navigateTo(){},
  switchTab(){switched++}
 },{
  getApp:()=>({bootstrap:async()=>{attempts++;if(attempts===1)throw Error('网络暂时不可用');return {openId:'owner'}}})
 });
 page.data.agreed=true;
 await page.start();
 assert.equal(stored.welcomeAcceptedV2,undefined);
 assert.match(page.data.error,/网络暂时不可用/);
 assert.equal(switched,0);
 await page.start();
 assert.equal(stored.welcomeAcceptedV2,true);
 assert.equal(switched,1);
});

test('a first-time report recipient can open one shared report without entering the author onboarding flow',async()=>{
 let readyChecks=0;const calls=[];
 const cloud=loadService('cloud',{
  getApp:()=>({ensureReady:async()=>{readyChecks++;throw Error('welcome required')}}),
  wx:{cloud:{callFunction:async request=>{calls.push(request);return {result:{success:true,data:{_id:'report-1',accessMode:'shared'}}};}}}
 });
 const shared=await cloud.callCloud('report',{action:'detail',payload:{reportId:'report-1',shareToken:'share-v2-example'}});
 assert.equal(shared.accessMode,'shared');
 assert.equal(readyChecks,0,'shared report reads must not trigger account onboarding');
 assert.equal(calls.length,1);
 await assert.rejects(()=>cloud.callCloud('report',{action:'detail',payload:{reportId:'report-1'}}),/welcome required/);
 assert.equal(readyChecks,1,'owner reads still require an initialized identity');
});

test('shared report page stays read-only, forwards safely, and keeps report text visible when media URLs fail',async()=>{
 let shareMutations=0,shareMenuCalls=0;
 const report={_id:'shared-report',accessMode:'shared',shareState:'active',mediaUnavailable:true,logoUnavailable:true,title:'在线报告',projectName:'隔离项目',companyName:'测试巡查单位',items:[{id:'issue-1',sourcePhotoId:'photo-1',number:1,description:'现场确认的收口问题'}],photos:[{id:'photo-1',sourceIndex:0,imagePath:'',annotatedImagePath:''}]};
 const dependencies={
  '../../../services/report':{
   getReportDetail:async()=>report,
   buildReportData:async()=>report,
   createReportShareToken:async()=>{shareMutations++;},
   revokeReportShareToken:async()=>{shareMutations++;}
  },
  '../../../services/cloud-media':{isCloudFileId:()=>false,resolveCloudFileUrls:async()=>({urls:{},failed:[]})},
  '../../../utils/report-identity':{buildReportNo:()=> 'CB-TEST'},
  '../../../utils/format':{mapResponsiblePartyText:value=>value,formatDateTime:()=>'',usesEditorialTypeface:()=>false},
  '../../../utils/router':{decodeReturnContext:()=>null,returnToContext(){}},
  '../../../utils/guide':{markGuideStep(){}},
  '../../../utils/system':{getWindowInfo:()=>({windowWidth:390,windowHeight:844})}
 };
 const wx={hideShareMenu(){},showShareMenu(){shareMenuCalls++;},showToast(){}};
 const {page}=loadPage('report/detail',dependencies,wx);
 await page.onLoad({reportId:'shared-report',shareToken:'share-v2-private-token'});
 await page.loadReport();
 assert.equal(page.data.isOwner,false,'server access mode must switch the page to recipient read-only state');
 assert.equal(page.data.report.shareToken,undefined,'the read response must not need to echo the bearer token');
 assert.equal(page.data.report.logoPreviewError,true,'a missing logo URL must not block the report cover');
 assert.equal(page.data.report.issueGroups[0].imagePreviewError,true,'a missing photo URL must become a recoverable per-photo placeholder');
 assert.equal(page.data.report.issueGroups[0].issues[0].description,'现场确认的收口问题','confirmed report text remains visible when temporary media URLs fail');
 assert.equal(shareMenuCalls,1,'an active report can be forwarded from its shared read-only view');
 assert.match(page.onShareAppMessage().path,/reportId=shared-report&shareToken=share-v2-private-token/);
 page.manageShare();
 page.chooseShareAction({currentTarget:{dataset:{action:'revoke'}}});
 await page.confirmShareAction();
 assert.equal(page.data.sharePanelOpen,false);
 assert.equal(shareMutations,0,'recipients cannot create, rotate, or revoke the owner link');
 const markup=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/report/detail/index.wxml'),'utf8');
 assert.match(markup,/wx:if="\{\{!isOwner\}\}" class="report-cover__readonly"/);
 assert.match(markup,/wx:if="\{\{isOwner\}\}" class="[^"]*share-manage"/);
});

test('photo permission denial is distinct from cancel so the UI can offer a recovery path',()=>{
 const {context}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{},
  '../../../services/inspection-media':{},
  '../../../services/project':{},
  '../../../services/inspection':{},
  '../../../utils/router':{},
  '../../../utils/guide':{},
  '../../../utils/coach':{},
  '../../../utils/inspection-model':{}
 },{getRecorderManager:()=>({})});
 assert.equal(context.isUserCancelledPrivacyOrPicker({errMsg:'chooseImage:fail cancel'}),true);
 assert.equal(context.isUserCancelledPrivacyOrPicker({errMsg:'chooseImage:fail auth deny'}),false);
 assert.equal(context.isPickerPermissionDenied({errMsg:'chooseImage:fail auth deny'}),true);
});

test('microphone denial exits recording state and keeps text entry as the fallback',()=>{
 let modal;
 const recorder={onStop(){},onError(){},offStop(){},offError(){}};
 const {component}=loadComponent('voice-recorder',{
  '../../services/speech':{transcribeVoiceFile:async()=>({}),mergeSpeechText:value=>value,formatSpeechError:()=>({message:'失败'})}
 },{getRecorderManager:()=>recorder,showModal:value=>{modal=value},showToast(){}});
 component.data.recording=true;
 component.handleRecorderError({errMsg:'startRecord:fail auth deny'});
 assert.equal(component.data.recording,false);
 assert.equal(modal.title,'需要麦克风权限');
 assert.match(modal.content,/直接输入文字/);
});

test('the actual capture-page voice gesture drops an upward-cancelled take and keeps a take slid back down',async()=>{
 let kept=0,transcribed=0;const toasts=[];
 const recorder={onStop(handler){this.stopHandler=handler;},onError(){},onStart(handler){this.startHandler=handler;},offStop(){},offError(){},offStart(){},start(){this.startHandler?.();},stop(){this.stopPromise=this.stopHandler?.({tempFilePath:'/tmp/voice.mp3',duration:1200});}};
 const {page}=loadPage('inspection/create',{
  '../../../services/inspection-media':{keepLocalFile:async value=>{kept++;return `/user-data/${value.split('/').pop()}`;}},
  '../../../services/speech':{transcribeVoiceFile:async()=>{transcribed++;return {text:'现场说明',fileID:'cloud://qa/voice'};},mergeSpeechText:(_before,next)=>next,formatSpeechError:()=>({message:'转写失败'})}
 },{
  getRecorderManager:()=>recorder,
  getSetting(options){options.success({authSetting:{'scope.record':true}});},
  showToast:value=>toasts.push(value),vibrateShort(){},
  getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){}
 },{setTimeout(){return 1;},clearTimeout(){}});
 page.createSessionKey=()=> 'voice-gesture-session';
 await page.onLoad({projectId:'qa-isolated'});
 page.data.form={projectId:'qa-isolated',issueDrafts:[{id:'photo-1',voiceText:'',analysisMode:'manual'}]};
 page.persistDraft=()=>true;

 page.handleRecordTouchStart({touches:[{clientY:220}]});
 await page.handleRecordLongPress({currentTarget:{dataset:{index:0}}});
 page.handleRecordMove({touches:[{clientY:150}]});
 assert.equal(page.data.recordCancelArmed,true,'the actual capture control enters its visible cancel state on an upward slide');
 page.handleRecordTouchEnd();
 await recorder.stopPromise;
 assert.equal(page.recordCancelled,true);
 assert.equal(kept,0,'cancelled audio is discarded before local persistence');
 assert.equal(transcribed,0,'cancelled audio is never uploaded for transcription');
 assert.equal(toasts.at(-1).title,'录音已取消');

 page.handleRecordTouchStart({touches:[{clientY:220}]});
 await page.handleRecordLongPress({currentTarget:{dataset:{index:0}}});
 page.handleRecordMove({touches:[{clientY:150}]});
 page.handleRecordMove({touches:[{clientY:195}]});
 assert.equal(page.data.recordCancelArmed,false,'sliding back down restores the active recording');
 page.handleRecordTouchEnd();
 await recorder.stopPromise;
 await new Promise(setImmediate);
 assert.equal(kept,1);
 assert.equal(transcribed,1);
 assert.equal(page.data.form.issueDrafts[0].voiceText,'现场说明');
});
