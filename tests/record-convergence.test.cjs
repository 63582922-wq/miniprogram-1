const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {harness}=require('./cloud-harness.cjs');
const read=p=>fs.readFileSync(require('node:path').resolve(__dirname,'..',p),'utf8');

test('capture has one add-photo entry below the photo list and a full-width expand target',()=>{
 const markup=read('miniprogram/pages/inspection/create/index.wxml');
 assert.equal((markup.match(/<text>继续添加<\/text>/g)||[]).length,1);
 assert.ok(markup.indexOf('<text>继续添加</text>')>markup.indexOf('class="issue-draft-list"'));
 assert.doesNotMatch(markup, /<text>拍照<\/text>|<text>从相册选择<\/text>/);
 assert.match(read('miniprogram/pages/inspection/create/index.wxss'),/\.issue-draft-card__expand\{flex:1/);
 assert.match(markup,/analyzeTotalPhotos && analyzeStageIndex !== 1/);
});

test('deleting a published report removes it from project detail but keeps the original inspection',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});
 h.table('inspections').set('i',{_id:'i',projectId:'p',reportId:'r',deleted:false,status:'confirmed',createdAt:1});
 h.table('reports').set('r',{_id:'r',projectId:'p',inspectionId:'i',deleted:false,createdAt:1});
 const report=h.load('report'),project=h.load('project');
 assert.equal((await report({action:'remove',payload:{reportId:'r'}})).success,true);
 const detail=await project({action:'detail',payload:{projectId:'p'}});
 assert.equal(detail.success,true);assert.equal(detail.data.reports.length,0);
 assert.equal(detail.data.inspections.length,1);assert.equal(h.table('inspections').get('i').reportId,'');
});

test('share confirmation actions are vertically and horizontally centered',()=>{
 const css=read('miniprogram/pages/report/detail/index.wxss');
 assert.match(css,/\.share-panel__button\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
});

test('four-photo review publishes the confirmed AI issue and adopted observation, then reopens the same content',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});
 const inspection=h.load('inspection'),report=h.load('report');
 const photos=Array.from({length:4},(_,i)=>({id:'photo'+i,imagePath:'cloud://env/inspection-images/user/owner/'+i+'.png',analysisMode:i===0?'ai':'manual',caption:i===0?'接缝处可见空隙':''}));
 const description='窗台木饰面收口有缺口，影响接缝完整性';
 const confirmed=await inspection({action:'confirm',payload:{requestId:'confirmed-ai',form:{projectId:'p',projectName:'项目',title:'现场记录',issueDrafts:photos},items:[{id:'issue',sourcePhotoId:'photo0',sourceIndex:0,description,severity:'normal',responsibleParty:'pending',images:[photos[0].imagePath]}]}});
 assert.equal(confirmed.success,true);
 const built=await report({action:'build',payload:{inspectionId:confirmed.data.inspectionId}});
 const saved=await report({action:'save',payload:{...built.data,requestId:'report-ai',status:'published'}});
 assert.equal(saved.success,true);
 const reopened=await report({action:'detail',payload:{reportId:saved.data._id}});
 assert.equal(reopened.success,true);assert.equal(reopened.data.items[0].description,description);
 assert.equal(reopened.data.photos.length,4);assert.equal(reopened.data.photos[0].caption,'接缝处可见空隙');
});
