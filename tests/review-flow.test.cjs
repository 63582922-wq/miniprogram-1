const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {harness}=require('./cloud-harness.cjs');
test('review response loss, cold reopen and retry publish exactly one report and clear only after success',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});const inspection=h.load('inspection'),report=h.load('report');
 const cache=new Map(),nav=[];global.wx={getStorageSync:k=>structuredClone(cache.get(k)),setStorageSync:(k,v)=>cache.set(k,structuredClone(v)),removeStorageSync:k=>cache.delete(k),showModal(){},showToast(){},showLoading(){},hideLoading(){},redirectTo:o=>nav.push(o.url)};
 const D=require('../miniprogram/utils/inspection-draft');let lost=true;
 D.writeDraft('s',{projectId:'p',projectName:'项目',issueDrafts:[{id:'photo',imagePath:'cloud://env/inspection-images/user/owner/a.png',caption:'旧记录照片补充'}]});
 D.patchDraft('s',{analysis:{items:[{id:'i',sourcePhotoId:'photo',sourceIndex:0,description:'待核对'}],summary:'本次巡查共整理出 1 个待人工确认的问题项。'}});
 const unwrap=async(p)=>{const r=await p;if(!r.success)throw Error(r.message);return r.data;};
 function load(){let config;const filename=require.resolve('../miniprogram/pages/inspection/result/index.js');
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{Page:c=>config=c,wx:global.wx,console,require:n=>n.endsWith('/services/inspection')?{confirmInspection:async payload=>{const result=await unwrap(inspection({action:'confirm',payload}));if(lost){lost=false;throw Error('simulated response timeout')}return result;}}:
   n.endsWith('/services/report')?{buildReportData:payload=>unwrap(report({action:'build',payload})),saveReport:payload=>unwrap(report({action:'save',payload}))}:
   n.endsWith('/services/inspection-media')?{uploadDraftMedia:async form=>form}:n.endsWith('/utils/guide')?{markGuideStep(){}}:n.endsWith('/utils/router')?{encodeReturnContext:()=>'',returnToContext(){}}:require(path.resolve(path.dirname(filename),n))});
  const page={...config,data:structuredClone(config.data),setData(p){for(const [k,v]of Object.entries(p)){const bits=k.split('.');let target=this.data;bits.slice(0,-1).forEach(b=>{target=target[b]});target[bits.at(-1)]=v;}}};return page;
 }
 const a=load();a.onLoad({sessionKey:'s'});assert.equal(a.data.issueGroups[0].caption,'旧记录照片补充','legacy note should remain visible during review');a.handleItemChange({detail:{index:0,field:'description',value:'人工确认的内容'}});await a.handleSubmit();
 assert.equal(a.data.submissionLocked,true);assert.ok(D.readDraft('s').form);assert.equal(h.table('inspections').size,1);assert.equal(h.table('reports').size,0);
 const b=load();b.onLoad({sessionKey:'s'});assert.equal(b.data.issues[0].description,'人工确认的内容');assert.equal(b.data.summary.aiSummary,'','count-only AI summary is omitted by default');await b.handleSubmit();
 assert.equal(h.table('inspections').size,1);assert.equal(h.table('reports').size,1);assert.equal([...h.table('reports').values()][0].snapshot.items[0].description,'人工确认的内容');
 assert.equal([...h.table('reports').values()][0].snapshot.photos[0].caption,'旧记录照片补充','removing the new per-photo field must preserve an existing note unchanged');
 assert.equal([...h.table('reports').values()][0].snapshot.summary,'','the frozen report must not repeat generated counts as a summary');
 assert.equal(D.readDraft('s').form,null);assert.equal(cache.get('s:complete'),true);assert.equal(nav.length,1);
});
