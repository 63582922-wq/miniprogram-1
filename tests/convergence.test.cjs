const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
function load(relative,wx,modules={},extras={}){
 let config;const file=path.join(root,relative);
 vm.runInNewContext(fs.readFileSync(file,'utf8'),{Page:c=>config=c,App:c=>config=c,wx,console,setTimeout:fn=>{queueMicrotask(fn);return 1},clearTimeout(){},getApp:()=>({ensureReady:async()=>{},globalData:{userInfo:{openId:'owner'}}}),require:n=>modules[n]||require(path.resolve(path.dirname(file),n)),...extras});
 return {...config,data:structuredClone(config.data||{}),setData(p){for(const [k,v]of Object.entries(p)){const parts=k.split('.');let obj=this.data;for(const bit of parts.slice(0,-1))obj=obj[bit];obj[parts.at(-1)]=v;}}};
}
function environment(){const store=new Map(),events=[];const wx={getStorageSync:k=>structuredClone(store.get(k)),setStorageSync:(k,v)=>store.set(k,structuredClone(v)),removeStorageSync:k=>store.delete(k),showModal:o=>events.push(o),showToast(){},navigateTo:o=>events.push(o),redirectTo:o=>events.push(o),getRecorderManager:()=>({onStop(){},onError(){}}),enableAlertBeforeUnload(){},disableAlertBeforeUnload(){}};global.wx=wx;global.getApp=()=>({globalData:{userInfo:{openId:'owner'}}});return {store,events,wx};}
const flush=()=>new Promise(r=>setImmediate(r));
test('photo picker locks project selection, ignores duplicate taps and stale image callbacks',async()=>{
 const {wx}=environment();let picker,timer,opens=0;
 wx.showActionSheet=o=>o.success({tapIndex:1});wx.chooseImage=o=>{picker=o;opens++;};
 const page=load('miniprogram/pages/inspection/create/index.js',wx,{}, {setTimeout:fn=>{timer=fn;return 1;}});
 page.setData({sessionKey:'B-session','form.projectId':'B',projects:[{_id:'A',name:'A'}]});
 page.chooseImages();page.chooseImages();assert.equal(opens,1);assert.equal(page.data.pickingImages,true);
 await page.handleProjectChange({detail:{value:0}});assert.equal(page.data.form.projectId,'B');
 timer();assert.equal(page.data.pickingImages,false);assert.match(page.data.pickerError,/未返回/);
 picker.success({tempFilePaths:['/stale.jpg']});await flush();assert.equal(page.data.form.issueDrafts.length,0);
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
test('out-of-order project searches only display latest query',async()=>{
 const {wx}=environment(),pending=[];const page=load('miniprogram/pages/project/list/index.js',wx,{'../../../services/project':{listProjects:()=>new Promise(r=>pending.push(r))}});
 const a=page.loadProjects();page.data.keyword='B';const b=page.loadProjects();pending[1]({list:[{_id:'B'}],page:1});await b;pending[0]({list:[{_id:'A'}],page:1});await a;assert.equal(page.data.projectList[0]._id,'B');delete global.getApp;
});
test('report tab starts with all reports and retry event does not append',async()=>{
 const {wx}=environment(),calls=[];const page=load('miniprogram/pages/report/list/index.js',wx,{'../../../services/report':{listReports:async p=>{calls.push(p);return {list:[{_id:'r1',title:'云栖里巡查报告',publishedAt:1}],page:1}}}});
 page.onLoad({});assert.equal(page.data.isProjectMode,false);await page.loadReports({type:'tap'});assert.equal(calls[0].page,1);assert.equal(calls[0].projectId,'');assert.equal(page.data.reports[0].displayTitle,'云栖里');delete global.getApp;
});
