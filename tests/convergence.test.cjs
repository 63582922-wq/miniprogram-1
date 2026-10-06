const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function load(relative,wx,modules={},extras={}){
 let config;const file=path.join(root,relative);
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{Page:c=>config=c,App:c=>config=c,wx,console,setTimeout:fn=>{queueMicrotask(fn);return 1},clearTimeout(){},getApp:()=>({ensureReady:async()=>{},globalData:{userInfo:{openId:'owner'}}}),require:n=>modules[n]||require(path.resolve(path.dirname(file),n)),...extras});
 return {...config,data:structuredClone(config.data||{}),setData(p){for(const [k,v]of Object.entries(p)){const parts=k.split('.');let obj=this.data;for(const bit of parts.slice(0,-1))obj=obj[bit];obj[parts.at(-1)]=v;}}};
}
function environment(){const store=new Map(),events=[];const wx={getStorageSync:k=>structuredClone(store.get(k)),setStorageSync:(k,v)=>store.set(k,structuredClone(v)),removeStorageSync:k=>store.delete(k),showModal:o=>events.push(o),showToast(){},navigateTo:o=>events.push(o),redirectTo:o=>events.push(o),getRecorderManager:()=>({onStop(){},onError(){}}),enableAlertBeforeUnload(){},disableAlertBeforeUnload(){}};global.wx=wx;global.getApp=()=>({globalData:{userInfo:{openId:'owner'}}});return {store,events,wx};}
const flush=()=>new Promise(r=>setImmediate(r));
test('photo AI runs immediately, stays in capture, and preserves earlier photo results',async()=>{
 const {wx,events}=environment();
 const D=require('../miniprogram/utils/inspection-draft');
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{});
 page.data.sessionKey='direct-photo-ai';page.ownsDraft=true;
 page.data.form={projectId:'p',issueDrafts:[{id:'a',imagePath:'/a.jpg',analysisMode:'manual',voiceText:''},{id:'b',imagePath:'/b.jpg',analysisMode:'manual',voiceText:''}]};
 page.persistDraft=()=>{D.writeDraft(page.data.sessionKey,page.data.form);return true;};
 page.clearAnalyzeTaskPolling=()=>{};
 let launched=0;
 page.handleAnalyze=async()=>{launched++;page.waitingForAnalysis=true;page.pendingInputVersion=D.readDraft(page.data.sessionKey).inputVersion;};
 page.persistDraft();
 await page.recognizePhoto({currentTarget:{dataset:{id:'a'}}});
 assert.equal(launched,1);assert.equal(page.data.form.issueDrafts[0].analysisMode,'ai');assert.equal(page.data.form.issueDrafts[1].analysisMode,'manual');
 await page.completeAnalyzeSuccess(page.data.form,{items:[{id:'ia',sourcePhotoId:'a',sourceIndex:0,description:'接缝缺胶'}],aiMode:'model'});
 assert.equal(events.length,0,'per-photo success must not navigate to review');
 assert.equal(page.data.form.issueDrafts[0].aiIssues[0],'接缝缺胶');
 await page.recognizePhoto({currentTarget:{dataset:{id:'b'}}});
 assert.equal(launched,2);assert.equal(page.data.form.issueDrafts.filter(p=>p.analysisMode==='ai').length,1);
 await page.completeAnalyzeSuccess(page.data.form,{items:[{id:'ib',sourcePhotoId:'b',sourceIndex:1,description:'饰面破损'}],aiMode:'model'});
 const saved=D.readDraft(page.data.sessionKey);
 assert.deepEqual(saved.review.items.map(i=>i.description),['接缝缺胶','饰面破损']);
 assert.equal(saved.analysis.items.length,2);assert.equal(events.length,0);
 await page.handleContinueReview();
 assert.equal(launched,2,'bottom action must not launch AI again');
 assert.match(events.at(-1).url,/inspection\/result/);
 page.data.form.issueDrafts.push({id:'c',imagePath:'/c.jpg',analysisMode:'manual',voiceText:''});
 page.persistDraft();
 await page.handleContinueReview();
 assert.deepEqual(D.readDraft(page.data.sessionKey).review.items.map(i=>i.description),['接缝缺胶','饰面破损'],'adding a manual photo must not erase earlier AI issues');
 assert.equal(launched,2);
 delete global.getApp;
});
test('photo picker locks project selection, ignores duplicate taps and stale image callbacks',async()=>{
 const {wx}=environment();let picker,timer,opens=0;
 wx.showActionSheet=o=>o.success({tapIndex:1});wx.chooseImage=o=>{picker=o;opens++;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{}, {setTimeout:fn=>{timer=fn;return 1;}});
 page.setData({sessionKey:'B-session','form.projectId':'B',projects:[{_id:'A',name:'A'}]});
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});assert.equal(opens,1);assert.equal(page.data.pickingImages,true);
 await page.handleProjectChange({detail:{value:0}});assert.equal(page.data.form.projectId,'B');
 timer();assert.equal(page.data.pickingImages,false);assert.match(page.data.pickerError,/未返回/);
 picker.success({tempFilePaths:['/stale.jpg']});await flush();assert.equal(page.data.form.issueDrafts.length,0);
 delete global.getApp;
});
test('public legal and service copy describes online reports without promising PDF export',()=>{
 const markup=fs.readFileSync(path.join(root,'miniprogram/pages/legal/index.wxml'),'utf8');
 assert.match(markup,/已发布的在线报告/,'the documented delivery artifact is the online report');
 assert.doesNotMatch(markup,/PDF|\.pdf/i,'the user-facing service disclosure must not promise a PDF flow excluded from the current product scope');
 assert.match(markup,/作者可撤销在线分享链接/,'share revocation remains accurately disclosed');
 assert.match(markup,/后台标记方式，不代表关联数据已从云端彻底擦除/,'soft deletion must not be presented as permanent erasure');
 assert.match(markup,/不能作为账号注销或个人信息删除的替代/,'record deletion must not be presented as account deletion');
 assert.match(markup,/个人信息权利申请/,'users have a discoverable rights request route');
 assert.match(markup,/不会自动撤销已发布报告的分享链接/,'account closure does not silently revoke links');
 assert.match(markup,/已受理.*不代表资料已删除或账号已注销/,'submission receipt is not misrepresented as completed erasure');
});

test('rights request handling is backed by an isolated server collection and client cannot impersonate request owner',()=>{
 const auth=fs.readFileSync(path.join(root,'cloudfunctions/auth/index.js'),'utf8');
 const setup=fs.readFileSync(path.join(root,'cloudfunctions/setupdb/index.js'),'utf8');
 assert.match(auth,/case "submitPrivacyRequest"/);
 assert.match(auth,/case "listPrivacyRequests"/);
 assert.match(auth,/openId: OPENID/);
 assert.match(auth,/PRIVACY_REQUEST_TYPES\.includes\(requestType\)/);
 assert.match(setup,/"privacy_requests"/);
});

test('material privacy updates require the current consent version before account bootstrap',()=>{
 const app=fs.readFileSync(path.join(root,'miniprogram/app.js'),'utf8');
 const welcome=fs.readFileSync(path.join(root,'miniprogram/pages/welcome/index.js'),'utf8');
 const consent=fs.readFileSync(path.join(root,'miniprogram/utils/privacy-consent.js'),'utf8');
 assert.match(consent,/PRIVACY_CONSENT_KEY\s*=\s*"welcomeAcceptedV2"/);
 assert.match(app,/getStorageSync\(PRIVACY_CONSENT_KEY\)/,'startup and protected page entry use the shared current consent key');
 assert.doesNotMatch(app,/welcomeAcceptedV1/,'old acceptance cannot silently bypass the updated terms');
 assert.match(welcome,/setStorageSync\(PRIVACY_CONSENT_KEY,\s*true\)/,'consent is recorded only from the explicit welcome action');
 assert.doesNotMatch(welcome,/welcomeAcceptedV1/);
});

test('WeChat privacy authorization is declared, shown before use and resolved through the platform agreement control',()=>{
 const app=fs.readFileSync(path.join(root,'miniprogram/app.json'),'utf8');
 const runtime=fs.readFileSync(path.join(root,'miniprogram/utils/privacy.js'),'utf8');
 const nav=fs.readFileSync(path.join(root,'miniprogram/components/page-nav-bar/index.wxml'),'utf8');
 const navJs=fs.readFileSync(path.join(root,'miniprogram/components/page-nav-bar/index.js'),'utf8');
 assert.match(app,/"__usePrivacyCheck__"\s*:\s*true/);
 assert.match(runtime,/wx\.onNeedPrivacyAuthorization/);
 assert.match(runtime,/resolve\(\{event:"disagree"\}\)/);
 assert.match(nav,/open-type="agreePrivacyAuthorization"/);
 assert.match(navJs,/wx\.openPrivacyContract/);
});

test('mini-program pages do not bypass the owner-checked cloud-function data boundary',()=>{
 const pagesRoot=path.join(root,'miniprogram/pages');
 const stack=[pagesRoot];
 while(stack.length){
  const current=stack.pop();
  for(const entry of fs.readdirSync(current,{withFileTypes:true})){
   const file=path.join(current,entry.name);
   if(entry.isDirectory())stack.push(file);
   else if(entry.isFile()&&entry.name.endsWith('.js')){
    const source=fs.readFileSync(file,'utf8');
    assert.doesNotMatch(source,/wx\.cloud\.database\s*\(|\.collection\s*\(/,`${path.relative(root,file)} must use scoped cloud services, not direct database access`);
   }
  }
 }
});

test('the active mini-program client contains no PDF service entry or profile configuration',()=>{
 const reportService=fs.readFileSync(path.join(root,'miniprogram/services/report.js'),'utf8');
 const settingsPage=fs.readFileSync(path.join(root,'miniprogram/pages/settings/index.js'),'utf8');
 const settingsTemplate=fs.readFileSync(path.join(root,'miniprogram/pages/settings/index.wxml'),'utf8');
 assert.doesNotMatch(reportService,/createReportPdfTask|getReportPdfTaskStatus|createPdfTask|getPdfTaskStatus/);
 assert.doesNotMatch(settingsPage,/reportPdfEngine|reportPdfServiceUrl|pdf\.haolizhiguan/);
 assert.doesNotMatch(settingsTemplate,/PDF|\.pdf/i);
});
test('slow native album selection pauses picker timeout while app is hidden and accepts callback after resume',async()=>{
 const {wx}=environment();let picker,nextTimer=0;const timers=new Map();
 wx.getAppBaseInfo=()=>({platform:'ios'});
 wx.chooseMedia=options=>{picker=options;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection-media':{keepLocalFile:async value=>value}
 },{
  setTimeout:fn=>{const id=++nextTimer;timers.set(id,fn);return id;},
  clearTimeout:id=>timers.delete(id)
 });
 page.restoreDraft=()=>{};page.persistDraft=()=>true;
 page.setData({sessionKey:'slow-picker-session','form.projectId':'project-b',projects:[{_id:'project-b',name:'B'}]});
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});
 const firstTimer=page.pickerTimer;
 assert.ok(timers.has(firstTimer));
 page.onHide();
 assert.equal(timers.has(firstTimer),false,'background time must not consume the native picker callback window');
 assert.equal(page.pickerTimeoutPaused,true);
 await page.onShow();
 assert.notEqual(page.pickerTimer,firstTimer,'resume starts a fresh foreground callback window');
 assert.ok(timers.has(page.pickerTimer));
 picker.success({tempFiles:[{tempFilePath:'/slow-album-selection.jpg'}]});
 await flush();
 assert.equal(page.data.form.issueDrafts.length,1);
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/slow-album-selection.jpg');
 assert.equal(page.data.pickingImages,false);
 delete global.getApp;
});
test('AI progress label stays neutral while the stage text explains ongoing or partial work',async()=>{
 const {wx}=environment();
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection':{readInspectionTaskStatus:async()=>({status:'failed',totalPhotos:8,completedPhotos:6,errorMessage:'AI 服务暂时不可用'})},
  '../../../utils/inspection-draft':{readDraft:()=>({inputVersion:4})}
 });
 page.setData({analyzeTaskId:'task',sessionKey:'session',analyzing:true});
 page.waitingForAnalysis=true;page.pendingInputVersion=4;page.clearAnalyzeTaskPolling=()=>{};
 await page.pollAnalyzeTaskStatus();
 assert.equal(page.data.analyzeProgressLabel,'进度');
 assert.equal(page.data.analyzeStageText,'已完成 6/8 张');
 assert.equal(page.data.analyzeError,'AI 服务暂时不可用');
 delete global.getApp;
});
test('capture prefers chooseMedia and commits the returned temp file into the draft',async()=>{
 const {wx}=environment();let picker;
 delete wx.chooseImage;
 wx.chooseMedia=o=>{picker=o;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection-media':{keepLocalFile:async value=>value},
  '../../../services/project':{listProjects:async()=>({list:[]})}
 },{setTimeout:()=>999});
 page.setData({sessionKey:'media-session','form.projectId':'project-b',projects:[{_id:'project-b',name:'B'}]});
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});
 picker.success({tempFiles:[{tempFilePath:'/selected-from-album.jpg'}]});
 await flush();
 assert.equal(page.data.form.issueDrafts.length,1);
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/selected-from-album.jpg');
 assert.equal(page.data.form.issueDrafts[0].displayImagePath,'/selected-from-album.jpg');
 delete global.getApp;
});
test('developer tool picker prefers the legacy callback without changing the real-device order',async()=>{
 const {wx}=environment();let legacyPicker,mediaCalls=0;
 wx.getAppBaseInfo=()=>({platform:'devtools'});
 wx.chooseImage=o=>{legacyPicker=o;};
 wx.chooseMedia=()=>{mediaCalls+=1;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection-media':{keepLocalFile:async value=>value},
  '../../../services/project':{listProjects:async()=>({list:[]})}
 },{setTimeout:()=>999});
 page.setData({sessionKey:'devtools-session','form.projectId':'project-b',projects:[{_id:'project-b',name:'B'}]});
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});
 assert.ok(legacyPicker);
 assert.equal(mediaCalls,0);
 legacyPicker.success({tempFilePaths:['/devtools-selected.jpg']});
 await flush();
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/devtools-selected.jpg');
 delete global.getApp;
});
test('developer tool is still detected when getDeviceInfo reports the host OS',async()=>{
 const {wx}=environment();let legacyPicker,mediaCalls=0;
 wx.getDeviceInfo=()=>({platform:'mac'});
 wx.getAppBaseInfo=()=>({platform:'devtools'});
 wx.chooseImage=o=>{legacyPicker=o;};
 wx.chooseMedia=()=>{mediaCalls+=1;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection-media':{keepLocalFile:async value=>value},
  '../../../services/project':{listProjects:async()=>({list:[]})}
 },{setTimeout:()=>999});
 page.setData({sessionKey:'devtools-host-platform-session','form.projectId':'project-b',projects:[{_id:'project-b',name:'B'}]});
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});
 assert.ok(legacyPicker);
 assert.equal(mediaCalls,0);
 legacyPicker.success({tempFilePaths:['/devtools-host-platform-selected.jpg']});
 await flush();
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/devtools-host-platform-selected.jpg');
 delete global.getApp;
});
test('capture edits text, analysis choice and replacement photo by stable photo ID without mutating the array path',async()=>{
 const {wx}=environment();
 wx.getAppBaseInfo=()=>({platform:'ios'});
 wx.showModal=options=>options.success({confirm:true});
 wx.chooseMedia=options=>options.success({tempFiles:[{tempFilePath:'/replacement.jpg'}]});
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection-media':{keepLocalFile:async value=>`/saved${value}`}
 });
 let saves=0;
 page.persistDraft=()=>{saves++;return true;};
 page.setData({form:{projectId:'p',issueDrafts:[
  {id:'photo-a',imagePath:'/a.jpg',annotations:[{id:'mark-a'}]},
  {id:'photo-b',imagePath:'/b.jpg',voiceText:'保留这段说明',annotations:[{id:'mark-b'}],annotationCount:1}
 ]}});
 page.handleIssueVoiceTextInput({currentTarget:{dataset:{id:'photo-b',index:1}},detail:{value:'输入后的现场说明'}});
 assert.ok(Array.isArray(page.data.form.issueDrafts));
 assert.equal(page.data.form.issueDrafts[1].voiceText,'输入后的现场说明');
 page.handleAnalysisModeChange({currentTarget:{dataset:{id:'photo-b',index:1,mode:'ai'}}});
 assert.equal(page.data.form.issueDrafts[1].analysisMode,'ai');
 await page.replaceIssueImage({currentTarget:{dataset:{id:'photo-b',index:1}}});
 assert.ok(Array.isArray(page.data.form.issueDrafts));
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/a.jpg');
 assert.deepEqual(page.data.form.issueDrafts[0].annotations,[{id:'mark-a'}]);
 assert.equal(page.data.form.issueDrafts[1].imagePath,'/saved/replacement.jpg');
 assert.equal(page.data.form.issueDrafts[1].voiceText,'输入后的现场说明');
 assert.equal(page.data.form.issueDrafts[1].annotations.length,0);
 assert.equal(page.data.form.issueDrafts[1].analysisMode,'ai');
 assert.equal(saves,3);
 delete global.getApp;
});
test('one compact per-photo processing control opens choices and updates only the selected photo',()=>{
 const {wx}=environment();let actionSheetCalls=0;
 wx.showActionSheet=()=>{actionSheetCalls++;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{});
 page.setData({form:{projectId:'p',issueDrafts:[
  {id:'photo-a',analysisMode:'manual'},
  {id:'photo-b',analysisMode:'manual'}
 ]}});
 page.persistDraft=()=>true;
 page.startPhotoRecognition=()=>{};
 page.chooseSinglePhotoProcessing({currentTarget:{dataset:{id:'photo-b',index:1}}});
 assert.equal(page.data.photoChoiceOpen,true);
 assert.deepEqual(Array.from(page.data.photoChoiceIds),['photo-b']);
 page.choosePhotoProcessing({currentTarget:{dataset:{mode:'ai'}}});
 assert.equal(page.data.form.issueDrafts[0].analysisMode,'manual');
 assert.equal(page.data.form.issueDrafts[1].analysisMode,'ai');
 assert.equal(actionSheetCalls,0,'selection uses the same in-app panel as first-time photo import');
 delete global.getApp;
});
test('photo replacement and destructive menu are blocked while that photo voice is transcribing',async()=>{
 const {wx,events}=environment();let pickerCalls=0,menuCalls=0;
 wx.showActionSheet=()=>{menuCalls++;};wx.showModal=options=>events.push(options);
 wx.chooseMedia=()=>{pickerCalls++;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{});
 page.setData({form:{issueDrafts:[{id:'photo-1',imagePath:'/photo.jpg',isTranscribing:true}]}});
 page.persistDraft=()=>true;
 await page.replaceIssueImage({currentTarget:{dataset:{id:'photo-1',index:0}}});
 page.handlePhotoMenu({currentTarget:{dataset:{index:0}}});
 assert.equal(pickerCalls,0);
 assert.equal(menuCalls,0);
 assert.equal(events.length,0);
 delete global.getApp;
});
test('photo picker accepts both legacy path arrays and file objects',async()=>{
 const {wx}=environment();let picker;
 wx.getAppBaseInfo=()=>({platform:'devtools'});
 wx.chooseImage=o=>{picker=o;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{
  '../../../services/inspection-media':{keepLocalFile:async value=>value},
  '../../../services/project':{listProjects:async()=>({list:[]})}
 },{setTimeout:()=>999});
 page.setData({sessionKey:'picker-result-session','form.projectId':'project-b',projects:[{_id:'project-b',name:'B'}]});
 page.chooseImages({currentTarget:{dataset:{sourceType:'album'}}});
 picker.success({tempFiles:[{path:'/legacy-file-object.jpg'}]});
 await flush();
 assert.equal(page.data.form.issueDrafts[0].imagePath,'/legacy-file-object.jpg');
 delete global.getApp;
});
test('explicit project B wins over global A draft; failed reload preserves B and never chooses first project',async()=>{
 const {store,wx}=environment(),D=require('../miniprogram/utils/inspection-draft');
 D.writeDraft('A-session',{projectId:'A',note:'A evidence',issueDrafts:[{id:'a'}]});store.set('latestInspectionDraftMeta',{projectId:'A',sessionKey:'A-session'});
 let fail=false;const page=load('miniprogram/pages/inspection/create/index.js',wx,{'../../../services/project':{listProjects:async()=>{if(fail)throw Error('offline');return {list:[{_id:'A',name:'A'},{_id:'B',name:'B'}]}}}});
 await page.onLoad({projectId:'B'});await flush();assert.equal(page.data.form.projectId,'B');assert.equal(page.data.issueDraftCount,0);assert.notEqual(page.data.sessionKey,'A-session');assert.equal(D.readDraft('A-session').form.note,'A evidence');
 fail=true;await page.loadProjects();assert.equal(page.data.form.projectId,'B');assert.match(page.data.projectLoadError,/offline/);
 fail=false;page.setData({'form.projectId':'deleted'});await page.loadProjects();assert.equal(page.data.form.projectId,'deleted');assert.match(page.data.projectLoadError,/无权限/);
 delete global.getApp;
});
test('new project missing server ID retains the same request and does not navigate',async()=>{
 const {wx,store,events}=environment();let request;const page=load('miniprogram/pages/project/form/index.js',wx,{'../../../services/project':{saveProject:async p=>{request=p.requestId;return {}}},'../../../utils/guide':{markGuideStep(){}}});
 await page.onLoad({});page.data.form.name='isolated B';await page.handleSubmit();assert.equal(page.saved,undefined);assert.equal(events.some(e=>e.url),false);assert.equal(store.get('projectCreateDraftV2:owner').requestId,request);assert.equal(page.data.submissionLocked,true);
 delete global.getApp;
});
test('new project enters only the exact server-returned project and duplicate taps share one save',async()=>{
 const {wx,events}=environment();let calls=0,resolveSave;
 const page=load('miniprogram/pages/project/form/index.js',wx,{
  '../../../services/project':{saveProject:payload=>{calls++;assert.ok(payload.requestId);return new Promise(resolve=>{resolveSave=resolve;});}},
  '../../../utils/guide':{markGuideStep(){}}
 });
 await page.onLoad({});page.data.form.name='isolated project B';
 const first=page.handleSubmit();await page.handleSubmit();
 assert.equal(calls,1,'a rapid second tap must not create a second project');
 resolveSave({_id:'server-project-b'});await first;
 assert.equal(page.saved,true);
 assert.equal(events.filter(event=>event.url).length,1);
 assert.equal(events.find(event=>event.url).url,'/pages/project/detail/index?projectId=server-project-b');
 delete global.getApp;
});
test('out-of-order project searches only display latest query',async()=>{
 const {wx}=environment(),pending=[];const page=load('miniprogram/pages/project/list/index.js',wx,{'../../../services/project':{listProjects:()=>new Promise(r=>pending.push(r))}});
 const a=page.loadProjects();page.data.keyword='B';const b=page.loadProjects();pending[1]({list:[{_id:'B'}],page:1});await b;pending[0]({list:[{_id:'A'}],page:1});await a;assert.equal(page.data.projectList[0]._id,'B');delete global.getApp;
});
test('report tab starts with all reports and retry event does not append',async()=>{
 const {wx}=environment(),calls=[];const page=load('miniprogram/pages/report/list/index.js',wx,{'../../../services/report':{listReports:async p=>{calls.push(p);return {list:[{_id:'r1',title:'云栖里巡查报告',publishedAt:1,photoCount:3,issueCount:2},{_id:'r2',title:'旧报告',publishedAt:2}],page:1}}}});
 page.onLoad({});assert.equal(page.data.isProjectMode,false);await page.loadReports({type:'tap'});assert.equal(calls[0].page,1);assert.equal(calls[0].projectId,'');assert.equal(page.data.reports[0].displayTitle,'云栖里');assert.equal(page.data.reports[0].summaryDisplay,'3 张照片 · 2 项问题');assert.equal(page.data.reports[1].summaryDisplay,'打开查看详情');delete global.getApp;
});
test('inspection history refresh replaces an in-flight stale response and owns loading state',async()=>{
 const {wx}=environment(),pending=[];
 const page=load('miniprogram/pages/inspection/list/index.js',wx,{
  '../../../services/inspection':{listInspections:()=>new Promise(resolve=>pending.push(resolve))}
 });
 const oldLoad=page.loadInspections();
 const refresh=page.loadInspections();
 pending[1]({list:[{_id:'new',createdAt:2}],page:1,hasMore:false});
 await refresh;
 assert.equal(page.data.loading,false);
 pending[0]({list:[{_id:'deleted-stale',createdAt:1}],page:1,hasMore:false});
 await oldLoad;
 assert.deepEqual(page.data.inspectionList.map(item=>item._id),['new']);
 assert.equal(page.data.loading,false);
 delete global.getApp;
});
