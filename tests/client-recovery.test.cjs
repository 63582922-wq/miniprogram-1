const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

function loadPage(relative,dependencies={},wx={},timers={}){
 let config;const filename=path.resolve(__dirname,'../miniprogram/pages',relative,'index.js');
 const context={Page:c=>config=c,wx,console,Date,Math,setTimeout,clearTimeout,...timers,
  require:n=>dependencies[n]||require(path.resolve(path.dirname(filename),n))};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),context);
 const page={...config,data:structuredClone(config.data),setData(p){Object.assign(this.data,p)}};
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

function loadService(relative,{wx={},getApp=()=>null}={}){
 const filename=path.resolve(__dirname,'../miniprogram/services',relative+'.js');
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,wx,getApp,console,Date,Math,Promise,Error,Object,Array,String,Boolean,Number,JSON,setTimeout,clearTimeout});
 return module.exports;
}

test('hidden capture page cannot overwrite annotation draft on unload and releases native guard',()=>{
 let writes=0,disabled=0;
 const {page}=loadPage('inspection/create',{
  '../../../utils/inspection-draft':{writeDraft(){writes++},readDraft:()=>({})}
 },{getRecorderManager:()=>({}),getStorageSync:()=>null,setStorageSync(){},removeStorageSync(){},
  enableAlertBeforeUnload(){},disableAlertBeforeUnload(){disabled++}});
 page.data.sessionKey='s';page.data.form.issueDrafts=[{id:'photo',annotations:[]}];
 page.ownsDraft=true;page.clearAnalyzeTaskPolling=()=>{};
 page.onHide();assert.equal(writes,1);assert.equal(disabled,1);
 page.onUnload();assert.equal(writes,1,'stale capture must not replace newer annotation data');
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

test('normalization storage failure never reports save success; retry preserves upright source and geometry together',async()=>{
 let blocked=true,navigated=0,saved,modals=[];
 const {page}=loadPage('inspection/annotate',{
  '../../../utils/inspection-draft':{readDraft:()=>({form:{issueDrafts:[{id:'p'}]}}),updateIssueDraft:(session,id,patch)=>{if(blocked)throw Error('disk full');saved=patch;return {issueDrafts:[patch]};}},
  '../../../services/inspection-media':{keepLocalFile:async()=>'/durable/rendered.png'}
 },{navigateBack(){navigated++},showModal:m=>modals.push(m),showToast(){}});
 Object.assign(page.data,{sessionKey:'s',issueId:'p',annotations:[{id:'mark'}],annotationStage:{version:2},editorReady:true});
 page.selectComponent=()=>({exportImage:async()=>'/temporary/rendered.png'});
 page.handleNormalized({detail:{path:'/durable/upright.png',originalPath:'/durable/original.jpg'}});
 assert.match(page.data.storageError,/未能暂存/);await page.handleSave();assert.equal(navigated,0);assert.equal(modals.at(-1).title,'标注未保存');
 blocked=false;await page.handleSave();assert.equal(navigated,1);assert.equal(saved.imagePath,'/durable/upright.png');
 assert.equal(saved.sourceOriginalImagePath,'/durable/original.jpg');assert.equal(saved.annotatedImagePath,'/durable/rendered.png');assert.equal(saved.annotationDirty,false);assert.equal(saved.annotations[0].id,'mark');
});

test('PDF status query stops after three network failures, has explicit recovery, and stays stopped when hidden',async()=>{
 let nextId=0,calls=0;const queued=new Map();
 const {page}=loadPage('report/detail',{
  '../../../services/report':{getReportPdfTaskStatus:async()=>{calls++;throw Error('offline')}},
  '../../../services/settings':{},'../../../utils/guide':{markGuideStep(){}},'../../../utils/router':{}
 },{}, {setTimeout:f=>{queued.set(++nextId,f);return nextId;},clearTimeout:id=>queued.delete(id)});
 page.data.report={pdfTaskId:'job',status:'pdf_generating'};page.data.reportId='r';
 page.schedulePdfTaskPolling();
 for(let i=0;i<3;i++){const [id,fn]=queued.entries().next().value;queued.delete(id);fn();await new Promise(setImmediate);}
 assert.equal(calls,3);assert.equal(queued.size,0);assert.match(page.data.pdfStatusError,/恢复网络/);
 page.loadReport=async()=>{};await page.retryPdfStatus();assert.equal(page.data.pdfStatusError,'');assert.equal(queued.size,1);
 page.onHide();assert.equal(queued.size,0);page.schedulePdfTaskPolling();assert.equal(queued.size,0);
});

test('publication number stays fixed after PDF generation and saving does not remove other reports',async()=>{
 const copies=[];const {context}=loadPage('report/detail',{}, {env:{USER_DATA_PATH:'/user'},getFileSystemManager:()=>({copyFile:o=>{copies.push(o);o.success();},unlink(){throw Error('must not remove existing PDFs')},readdir(){throw Error('must not sweep user files')}})});
 const base={_id:'report-abcd',publishedAt:1700000000000,createdAt:1699000000000};
 assert.equal(context.buildReportNo({...base,generatedAt:1701000000000}),context.buildReportNo({...base,generatedAt:1702000000000}));
 await context.persistDownloadedPdfFile('/temp/report.pdf','project-HLZG-abcd.pdf');assert.equal(copies.length,1);
 const display=context.buildReportDisplayState({...base,snapshotVersion:2,status:'pdf_generating',updatedAt:Date.now()-240000});
 assert.equal(display.isPdfGenerating,true);assert.equal(display.isPdfFailed,false);
 const zero=context.buildIssueGroups([],[{id:'photo',imagePath:'cloud://original',annotatedImagePath:'cloud://marked'}]);
 assert.equal(zero[0].image,'cloud://original','zero-issue report must not show an orphan numbered annotation');
 assert.equal(zero[0].groupTitle,'现场照片 一','zero-issue report must not label a photo as a problem');
 const linked=context.buildIssueGroups([{id:'issue',sourcePhotoId:'photo',description:'已确认问题'}],[{id:'photo',imagePath:'cloud://original',annotatedImagePath:'cloud://marked'}]);
 assert.equal(linked[0].image,'cloud://marked','a linked issue should keep the annotated report image');
 assert.equal(linked[0].groupTitle,'问题 一','issue-bearing photo keeps the established problem numbering');
});

test('project detail directly continues the latest draft and keeps new record as an explicit choice',()=>{
 const navigated=[];
 const {page}=loadPage('project/detail',{
  '../../../services/project':{},
  '../../../utils/format':{},
  '../../../utils/router':{encodeReturnContext:()=> 'return-context'},
  '../../../utils/inspection-draft':{listDrafts:()=>[]}
 },{navigateTo:options=>navigated.push(options.url)});
 Object.assign(page.data,{loading:false,loadError:'',projectId:'project-b',project:{name:'项目 B'},drafts:[{sessionKey:'newest'},{sessionKey:'older'}]});
 page.goInspectionCreate();
 assert.match(navigated[0],/projectId=project-b/);
 assert.match(navigated[0],/sessionKey=newest/);
 page.goNewInspection();
 assert.doesNotMatch(navigated[1],/sessionKey=/);
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
 assert.equal(page.data.form.logoFileId,'cloud://env/logos/logo.png');
 assert.equal(page.data.form.logoPreview,'/tmp/company-logo.png');
 assert.equal(toast.title,'LOGO 已保存');
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

test('welcome only remembers consent after identity initialization succeeds and supports retry',async()=>{
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
 assert.equal(stored.welcomeAcceptedV1,undefined);
 assert.match(page.data.error,/网络暂时不可用/);
 assert.equal(switched,0);
 await page.start();
 assert.equal(stored.welcomeAcceptedV1,true);
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
