const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
function fixture(){const h=harness();h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});return h;}
function payload(){return {requestId:'request-1',form:{projectId:'p',issueDrafts:[{id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/a.png'},{id:'photo-b',imagePath:'cloud://env/inspection-images/user/owner/b.png'}]},items:[{id:'issue-a',sourcePhotoId:'photo-a',description:'一'},{id:'issue-b',sourcePhotoId:'photo-a',description:'二'}]};}
test('confirm retries converge, partial writes recover, source IDs persist, publication freezes',async()=>{
 const h=fixture(),confirm=h.load('inspection'),p=payload();let once=true;
 h.table('users').set('u',{openId:'owner',nickname:'隔离测试巡查员',phone:'010-00000000',deleted:false});
 h.table('app_settings').set('s',{openId:'owner',companyName:'测试报告抬头',companyPhone:'010-00000001',deleted:false});
 h.failWhen(n=>{if(n==='inspection_items'&&once){once=false;return true}return false});
 await assert.rejects(confirm({action:'confirm',payload:p}),/injected/);
 const pending=[...h.table('inspections').values()][0];assert.equal(pending.status,'preparing');
 assert.equal((await confirm({action:'detail',payload:{inspectionId:pending._id}})).success,false);
 h.failWhen(null);const first=await confirm({action:'confirm',payload:p});assert.equal(first.success,true);
 const second=await confirm({action:'confirm',payload:p});assert.equal(second.data.inspectionId,first.data.inspectionId);assert.equal(h.table('inspections').size,1);assert.equal(h.table('inspection_items').size,2);
 assert.equal([...h.table('inspection_items').values()][1].sourcePhotoId,'photo-a');
 await assert.rejects(confirm({action:'confirm',payload:{...p,items:[{...p.items[0],description:'changed'}]}}),/内容已变化/);
 const report=h.load('report');const built=await report({action:'build',payload:{inspectionId:first.data.inspectionId}});
 const published=await report({action:'save',payload:{...built.data,requestId:'publish'}});assert.equal(published.success,true);
 const r=published.data;assert.equal(r.snapshot.photos.length,2);assert.equal(r.snapshot.items.length,2);
 h.table('projects').get('p').name='改变后的项目';
 const again=await report({action:'save',payload:{...built.data,title:'overwrite'}});assert.equal(again.data._id,r._id);
 const reopened=await report({action:'detail',payload:{reportId:r._id}});assert.equal(reopened.data.projectName,'项目');
 h.table('reports').get(r._id).internalFutureField='private';h.table('reports').get(r._id).snapshot.items[0].internalFutureField='private';
 h.as('recipient');const read=await report({action:'detail',payload:{reportId:r._id,shareToken:r.shareToken}});assert.equal(read.success,true);assert.equal(read.data.accessMode,'shared');assert.equal(read.data.snapshot,undefined);assert.equal(read.data.items[0].aiRawResult,undefined);
 assert.equal(read.data.internalFutureField,undefined);assert.equal(read.data.items[0].internalFutureField,undefined);assert.equal(read.data.projectId,undefined);assert.equal(read.data.shareToken,undefined);
 assert.equal(read.data.inspectorPhone,'010-00000000');assert.equal(read.data.publisherName,'隔离测试巡查员');assert.equal(read.data.companyName,'测试报告抬头');
 h.table('users').get('u').nickname='后来修改';h.table('app_settings').get('s').companyName='后来抬头';
 const frozen=await report({action:'detail',payload:{reportId:r._id,shareToken:r.shareToken}});assert.equal(frozen.data.publisherName,'隔离测试巡查员');assert.equal(frozen.data.companyName,'测试报告抬头');
 assert.equal((await report({action:'detail',payload:{reportId:r._id}})).success,false);
 h.as('owner');await report({action:'revokeShareToken',payload:{reportId:r._id}});h.as('recipient');assert.equal((await report({action:'detail',payload:{reportId:r._id,shareToken:r.shareToken}})).success,false);
});
test('zero issues retain photos; foreign resources and wrong project are rejected',async()=>{
 const h=fixture(),fn=h.load('inspection'),p=payload();p.items=[];
 const r=await fn({action:'confirm',payload:p});assert.equal(r.success,true);assert.equal(h.table('inspections').get(r.data.inspectionId).photos.length,2);
 p.requestId='new';p.form.issueDrafts[0].imagePath='cloud://env/inspection-images/user/other/a.png';await assert.rejects(fn({action:'confirm',payload:p}),/不属于当前用户/);
 h.as('other');assert.equal((await fn({action:'confirm',payload:payload()})).success,false);
});
test('legacy company settings without deleted remain visible, update in place, and enter report snapshots',async()=>{
 const h=fixture();
 h.table('app_settings').set('legacy',{_id:'legacy',openId:'owner',companyName:'旧公司资料',companyPhone:'010-12345678',logoFileId:'cloud://env/logos/legacy.png',updatedAt:10});
 h.table('app_settings').set('removed',{_id:'removed',openId:'owner',companyName:'已删除资料',deleted:true,updatedAt:20});
 const settings=h.load('settings');
 const before=await settings({action:'detail'});
 assert.equal(before.data._id,'legacy');
 assert.equal(before.data.logoFileId,'cloud://env/logos/legacy.png');
 const saved=await settings({action:'save',payload:{companyName:'恢复后的公司资料',companyPhone:'010-87654321',logoFileId:'cloud://env/logos/recovered.png'}});
 assert.equal(saved.data._id,'legacy');
 assert.equal(saved.data.deleted,false);
 assert.equal(h.table('app_settings').size,2);
 h.table('users').set('u',{openId:'owner',nickname:'巡查员',deleted:false});
 const confirm=h.load('inspection');
 const p=payload();p.items=[];
 const inspection=await confirm({action:'confirm',payload:p});
 const report=h.load('report');
 const built=await report({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 assert.equal(built.data.companyName,'恢复后的公司资料');
 assert.equal(built.data.companyPhone,'010-87654321');
 assert.equal(built.data.logoFileId,'cloud://env/logos/recovered.png');
});
