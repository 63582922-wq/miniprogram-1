const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
function fixture(){const h=harness();h.table('projects').set('p',{_id:'p',name:'项目',address:'测试地址',ownerOpenId:'owner',deleted:false});return h;}
function payload(){return {requestId:'request-1',form:{projectId:'p',issueDrafts:[{id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/a.png'},{id:'photo-b',imagePath:'cloud://env/inspection-images/user/owner/b.png'}]},items:[{id:'issue-a',sourcePhotoId:'photo-a',description:'一'},{id:'issue-b',sourcePhotoId:'photo-a',description:'二'}]};}
test('confirm retries converge, partial writes recover, source IDs persist, publication freezes',async()=>{
 const h=fixture(),confirm=h.load('inspection'),p=payload();let once=true;
 h.table('users').set('u',{openId:'owner',nickname:'隔离测试巡查员',phone:'010-00000000',deleted:false});
 h.table('app_settings').set('s',{openId:'owner',companyName:'测试报告抬头',companyPhone:'010-00000001',companyAddress:'测试单位地址',logoFileId:'cloud://env/logos/user/owner/logo.png',deleted:false});
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
 const r=published.data;assert.equal(r.snapshot.photos.length,2);assert.equal(r.snapshot.items.length,2);assert.equal(r.snapshot.projectAddress,'测试地址');
 assert.equal(r.snapshot.companyAddress,'测试单位地址');assert.equal(r.snapshot.logoFileId,'cloud://env/logos/user/owner/logo.png');
 h.table('projects').get('p').name='改变后的项目';
 const again=await report({action:'save',payload:{...built.data,title:'overwrite'}});assert.equal(again.data._id,r._id);
 const reopened=await report({action:'detail',payload:{reportId:r._id}});assert.equal(reopened.data.projectName,'项目');
 h.table('reports').get(r._id).internalFutureField='private';h.table('reports').get(r._id).snapshot.items[0].internalFutureField='private';
 h.as('recipient');const read=await report({action:'detail',payload:{reportId:r._id,shareToken:r.shareToken}});assert.equal(read.success,true);assert.equal(read.data.accessMode,'shared');assert.equal(read.data.snapshot,undefined);assert.equal(read.data.items[0].aiRawResult,undefined);
 assert.equal(read.data.internalFutureField,undefined);assert.equal(read.data.items[0].internalFutureField,undefined);assert.equal(read.data.projectId,undefined);assert.equal(read.data.shareToken,undefined);
 assert.equal(read.data.inspectorPhone,'010-00000000');assert.equal(read.data.publisherName,'隔离测试巡查员');assert.equal(read.data.companyName,'测试报告抬头');assert.equal(read.data.companyPhone,'010-00000001');assert.equal(read.data.companyAddress,'测试单位地址');assert.equal(read.data.projectAddress,'测试地址');assert.match(read.data.logoFileId,/^https:\/\/example\.com\//);
 h.table('users').get('u').nickname='后来修改';h.table('app_settings').get('s').companyName='后来抬头';h.table('app_settings').get('s').companyAddress='后来地址';
 const frozen=await report({action:'detail',payload:{reportId:r._id,shareToken:r.shareToken}});assert.equal(frozen.data.publisherName,'隔离测试巡查员');assert.equal(frozen.data.companyName,'测试报告抬头');assert.equal(frozen.data.companyAddress,'测试单位地址');
 assert.equal((await report({action:'detail',payload:{reportId:r._id}})).success,false);
 const originalToken=r.shareToken;
 assert.equal((await report({action:'createShareToken',payload:{reportId:r._id,rotate:true}})).success,false,
  'a read-only recipient cannot mint or rotate the owner share token');
 assert.equal((await report({action:'revokeShareToken',payload:{reportId:r._id}})).success,false,
  'a read-only recipient cannot revoke the owner share token');
 assert.equal(h.table('reports').get(r._id).shareToken,originalToken,'denied share administration leaves the current link intact');
 h.as('owner');await report({action:'revokeShareToken',payload:{reportId:r._id}});h.as('recipient');assert.equal((await report({action:'detail',payload:{reportId:r._id,shareToken:r.shareToken}})).success,false);
});
test('zero issues retain photos; foreign resources and wrong project are rejected',async()=>{
 const h=fixture(),fn=h.load('inspection'),p=payload();p.items=[];
 const r=await fn({action:'confirm',payload:p});assert.equal(r.success,true);assert.equal(h.table('inspections').get(r.data.inspectionId).photos.length,2);
 p.requestId='new';p.form.issueDrafts[0].imagePath='cloud://env/inspection-images/user/other/a.png';await assert.rejects(fn({action:'confirm',payload:p}),/不属于当前用户/);
 h.as('other');assert.equal((await fn({action:'confirm',payload:payload()})).success,false);
});

test('share-link rotation invalidates only the previous token and revoke closes the new link',async()=>{
 const h=fixture(),inspection=h.load('inspection'),reports=h.load('report');
 const created=await inspection({action:'confirm',payload:{requestId:'share-rotation',form:{projectId:'p',title:'隔离分享撤销测试',issueDrafts:[{id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/a.png'}]},items:[]}});
 assert.equal(created.success,true);
 const built=await reports({action:'build',payload:{inspectionId:created.data.inspectionId}});
 const published=await reports({action:'save',payload:{...built.data,requestId:'share-rotation-publish'}});
 assert.equal(published.success,true);
 const reportId=published.data._id,oldToken=published.data.shareToken;

 h.as('stranger');
 assert.equal((await reports({action:'createShareToken',payload:{reportId,rotate:true}})).success,false);
 assert.equal((await reports({action:'revokeShareToken',payload:{reportId}})).success,false);
 h.as('owner');
 const reused=await reports({action:'createShareToken',payload:{reportId}});
 assert.equal(reused.data.shareToken,oldToken,'sharing the same report again keeps its active link');
 const rotated=await reports({action:'createShareToken',payload:{reportId,rotate:true}});
 const newToken=rotated.data.shareToken;
 assert.ok(newToken && newToken!==oldToken,'explicit rotation creates a new unguessable link');

 h.as('recipient');
 assert.equal((await reports({action:'detail',payload:{reportId,shareToken:oldToken}})).success,false,'the previous token stops working immediately');
 const current=await reports({action:'detail',payload:{reportId,shareToken:newToken}});
 assert.equal(current.success,true);
 assert.equal(current.data.accessMode,'shared');
 assert.equal(current.data.shareToken,undefined,'the reader response never returns the bearer token');
 h.as('owner');
 assert.equal((await reports({action:'revokeShareToken',payload:{reportId}})).success,true);
 h.as('recipient');
 assert.equal((await reports({action:'detail',payload:{reportId,shareToken:newToken}})).success,false,'revocation invalidates the rotated link');
 h.as('owner');
 assert.equal((await reports({action:'detail',payload:{reportId}})).success,true,'revocation does not block the owner from reopening their report');
});

test('concurrent link rotation and revocation cannot overwrite a newer share state',async()=>{
 const h=fixture(),inspection=h.load('inspection'),reports=h.load('report');
 const created=await inspection({action:'confirm',payload:{requestId:'share-race',form:{projectId:'p',title:'并发分享状态测试',issueDrafts:[{id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/a.png'}]},items:[]}});
 const built=await reports({action:'build',payload:{inspectionId:created.data.inspectionId}});
 const published=await reports({action:'save',payload:{...built.data,requestId:'share-race-publish'}});
 const reportId=published.data._id,oldToken=published.data.shareToken;
 const [rotated,revoked]=await Promise.all([
  reports({action:'createShareToken',payload:{reportId,rotate:true}}),
  reports({action:'revokeShareToken',payload:{reportId}})
 ]);
 const row=h.table('reports').get(reportId);
 assert.equal(Number(rotated.success)+Number(revoked.success),1,'only the operation that wins the compare-and-set reports success');
 if(revoked.success){
  assert.equal(row.shareState,'revoked');
  h.as('recipient');
  assert.equal((await reports({action:'detail',payload:{reportId,shareToken:oldToken}})).success,false);
 }else{
  assert.equal(row.shareState,'active');
  assert.equal(row.shareToken,rotated.data.shareToken,'a losing request never returns an unsaved token');
  h.as('recipient');
  assert.equal((await reports({action:'detail',payload:{reportId,shareToken:row.shareToken}})).success,true);
 }
});

test('automatic analysis summary is omitted from report; explicitly entered inspector summary is retained',async()=>{
 const h=fixture(),inspection=h.load('inspection'),report=h.load('report');
 const generated=payload();generated.form.aiSummary='本次记录 2 个问题项。';
 const generatedResult=await inspection({action:'confirm',payload:generated});
 const generatedReport=await report({action:'build',payload:{inspectionId:generatedResult.data.inspectionId}});
 assert.equal(generatedReport.data.summary,'','model-generated count summary must not repeat report overview');
 assert.equal(h.table('inspections').get(generatedResult.data.inspectionId).aiSummary,'');

 const authored=payload();authored.requestId='human-summary';authored.form.aiSummary='木饰面收口与插座面板周边需复核。';authored.form.summarySource='inspector';
 const authoredResult=await inspection({action:'confirm',payload:authored});
 const authoredReport=await report({action:'build',payload:{inspectionId:authoredResult.data.inspectionId}});
 assert.equal(authoredReport.data.summary,'木饰面收口与插座面板周边需复核。');
});

test('custom responsible unit survives confirm, report freeze and recipient reopen without exposing extraction internals',async()=>{
 const h=fixture(),p=payload();p.items[0].responsiblePartyName='现场确认的王工';p.items[0].area='次卧';p.items[0].fieldEvidence={responsiblePartyName:'原文内部依据'};
 const inspected=await h.load('inspection')({action:'confirm',payload:p});
 const reports=h.load('report'),built=await reports({action:'build',payload:{inspectionId:inspected.data.inspectionId}});
 const saved=await reports({action:'save',payload:{...built.data,requestId:'custom-responsibility'}});
 h.as('recipient');
 const read=await reports({action:'detail',payload:{reportId:saved.data._id,shareToken:saved.data.shareToken}});
 assert.equal(read.success,true);assert.equal(read.data.items[0].responsiblePartyName,'现场确认的王工');assert.equal(read.data.items[0].area,'次卧');
 assert.equal(read.data.items[0].fieldEvidence,undefined);assert.equal(read.data.items[0].aiRawResult,undefined);
});
test('shared report keeps only normalized annotation geometry needed to match photo markers to issue numbers',async()=>{
 const h=fixture(),p=payload();
 p.form.issueDrafts[0].annotatedImagePath='cloud://env/inspection-images/user/owner/a-marked.png';
 p.form.issueDrafts[0].annotations=[
  {id:'point-1',type:'point',a:{x:.2,y:.3},b:{x:.25,y:.35},privateNote:'do not share'},
  {id:'point-2',type:'point',a:{x:.7,y:.8},b:{x:.75,y:.85}},
  {id:'point-3',type:'point',a:{x:.4,y:.6},b:{x:.43,y:.63}},
  {id:'box-4',type:'box',a:{x:.25,y:.35},b:{x:.55,y:.65},numbered:true,privateNote:'do not share'},
  {id:'ellipse-unmarked',type:'ellipse',a:{x:.2,y:.2},b:{x:.3,y:.3},privateNote:'do not share'},
  {id:'outside',type:'point',a:{x:2,y:.5},b:{x:.9,y:.9}},
  {id:'unknown',type:'secret',a:{x:.2,y:.3},b:{x:.3,y:.4}}
 ];
 p.items=[
  {id:'issue-1',sourcePhotoId:'photo-a',annotationId:'point-1',markerNumber:1,description:'问题一'},
  {id:'issue-2',sourcePhotoId:'photo-a',annotationId:'point-2',markerNumber:2,description:'问题二'},
  {id:'issue-3',sourcePhotoId:'photo-a',annotationId:'point-3',markerNumber:3,description:'问题三'},
  {id:'issue-4',sourcePhotoId:'photo-a',annotationId:'box-4',markerNumber:4,description:'框选问题四'}
 ];
 const inspection=await h.load('inspection')({action:'confirm',payload:p});assert.equal(inspection.success,true);
 const report=h.load('report'),built=await report({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 const published=await report({action:'save',payload:{...built.data,requestId:'publish-marked'}});
 h.as('recipient');
 const shared=await report({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
 assert.equal(shared.success,true);
 assert.equal(JSON.stringify(shared.data.photos[0].annotations.map(a=>a.id)),JSON.stringify(['point-1','point-2','point-3','box-4','ellipse-unmarked']));
 assert.equal(JSON.stringify(shared.data.photos[0].annotations[0].a),JSON.stringify({x:.2,y:.3}));
 assert.equal(shared.data.photos[0].annotations[0].privateNote,undefined);
 assert.equal(shared.data.photos[0].annotations.find(a=>a.id==='box-4').numbered,true,'numbered box state is required to render the report marker');
 assert.equal(shared.data.photos[0].annotations.find(a=>a.id==='ellipse-unmarked').numbered,undefined,'editing metadata on an unnumbered shape stays private');
 assert.equal(JSON.stringify(shared.data.items.map(item=>[item.annotationId,item.markerNumber])),JSON.stringify([['point-1',1],['point-2',2],['point-3',3],['box-4',4]]));
});
test('temporary photo URL failure does not block a shared report text payload',async()=>{
 const h=fixture(),inspections=h.load('inspection'),reports=h.load('report');
 const input=payload();
 input.requestId='reader-media-failure';
 input.form.issueDrafts=[{id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/private-photo.png'}];
 input.items=[{id:'issue-a',sourcePhotoId:'photo-a',description:'窗边收口需复核'}];
 const created=await inspections({action:'confirm',payload:input});
 const built=await reports({action:'build',payload:{inspectionId:created.data.inspectionId}});
 const published=await reports({action:'save',payload:{...built.data,requestId:'reader-media-failure-publish'}});
 h.as('recipient');
 h.failTempFileUrls(true);
 const reader=await reports({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
 assert.equal(reader.success,true,'temporary URL errors must not fail the whole report request');
 assert.equal(reader.data.mediaUnavailable,true);
 assert.equal(reader.data.items[0].description,'窗边收口需复核','confirmed report text remains readable');
 assert.equal(reader.data.photos[0].imagePath,'');
 assert.equal(JSON.stringify(reader.data).includes('cloud://env/inspection-images/user/owner/private-photo.png'),false,'unresolved cloud file IDs are not exposed to the reader');
});
test('numbered manual photo notes survive publication and read-only report reopen',async()=>{
 const h=fixture(),photo={id:'photo-a',imagePath:'cloud://env/inspection-images/user/owner/a.jpeg',annotatedImagePath:'cloud://env/inspection-annotated-images/user/owner/a.png',voiceText:'窗台收口待处理；胶缝有断点；墙面有污染',annotations:[
  {id:'point-a',type:'point',a:{x:.1,y:.2},b:{x:.14,y:.24}},
  {id:'point-b',type:'point',a:{x:.4,y:.5},b:{x:.45,y:.55}},
  {id:'point-c',type:'point',a:{x:.8,y:.7},b:{x:.85,y:.76}}
 ]};
 const {buildManualReviewItems}=require('../miniprogram/utils/inspection-model');
 const items=buildManualReviewItems([photo]);
 const saved=await h.load('inspection')({action:'confirm',payload:{requestId:'numbered-photo',form:{projectId:'p',title:'编号标注回归',issueDrafts:[photo]},items}});
 assert.equal(saved.success,true);
 const reports=h.load('report'),built=await reports({action:'build',payload:{inspectionId:saved.data.inspectionId}});
 assert.equal(JSON.stringify(built.data.items.map(item=>[item.annotationId,item.markerNumber,item.description])),JSON.stringify([
  ['point-a',1,'窗台收口待处理'],['point-b',2,'胶缝有断点'],['point-c',3,'墙面有污染']
 ]));
 const published=await reports({action:'save',payload:{...built.data,requestId:'numbered-photo-publish'}});
 h.as('recipient');
 const reopened=await reports({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
 assert.equal(reopened.success,true);
 assert.equal(JSON.stringify(reopened.data.items.map(item=>[item.annotationId,item.markerNumber,item.description])),JSON.stringify([
  ['point-a',1,'窗台收口待处理'],['point-b',2,'胶缝有断点'],['point-c',3,'墙面有污染']
 ]));
 assert.equal(JSON.stringify(reopened.data.photos[0].annotations.map(annotation=>annotation.id)),JSON.stringify(['point-a','point-b','point-c']));
});
test('legacy immutable snapshot restores a numbered box only from an exact same-photo issue annotation ID',async()=>{
 const h=fixture(),p=payload();
 p.form.issueDrafts=[{id:'photo-marked',imagePath:'cloud://env/inspection-images/user/owner/marked.jpeg',annotations:[
  {id:'box-linked',type:'box',a:{x:.2,y:.3},b:{x:.5,y:.6},numbered:true,privateNote:'hidden'},
  {id:'ellipse-other',type:'ellipse',a:{x:.6,y:.2},b:{x:.8,y:.4},numbered:false}
 ]}];
 p.items=[{id:'issue-linked',sourcePhotoId:'photo-marked',annotationId:'box-linked',markerNumber:1,description:'木作收口待处理'}];
 const inspection=await h.load('inspection')({action:'confirm',payload:p});assert.equal(inspection.success,true);
 const reports=h.load('report'),built=await reports({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 const published=await reports({action:'save',payload:{...built.data,requestId:'legacy-numbered-publish'}});assert.equal(published.success,true);
 // Simulate a report frozen before the marker display flag was allowlisted.
 delete h.table('reports').get(published.data._id).snapshot.photos[0].annotations[0].numbered;
 h.as('owner');
 const ownerView=await reports({action:'detail',payload:{reportId:published.data._id}});assert.equal(ownerView.success,true);
 assert.equal(ownerView.data.photos[0].annotations.find(a=>a.id==='box-linked').numbered,true);
 assert.equal(ownerView.data.photos[0].annotations.find(a=>a.id==='ellipse-other').numbered,undefined);
 h.as('recipient');
 const readerView=await reports({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});assert.equal(readerView.success,true);
 assert.equal(readerView.data.photos[0].annotations.find(a=>a.id==='box-linked').numbered,true);
 assert.equal(readerView.data.photos[0].annotations.find(a=>a.id==='box-linked').privateNote,undefined);
 assert.equal(readerView.data.photos[0].annotations.find(a=>a.id==='ellipse-other').numbered,undefined);
});
test('legacy shared report never promotes raw voice transcript or recording references into photo captions',async()=>{
 const h=fixture(),inspectionId='legacy-voice-inspection',reportId='legacy-voice-report',token='sr'+'a'.repeat(32);
 h.table('inspections').set(inspectionId,{_id:inspectionId,projectId:'p',inspectorOpenId:'owner',inspectionDate:Date.now(),deleted:false,status:'published',photos:[{
  id:'legacy-photo',sourceIndex:0,imagePath:'cloud://env/inspection-images/user/owner/legacy.jpg',
  voiceText:'原始转写：墙角可能有裂缝，请核对。',voiceStorageFileId:'cloud://env/speech-input/user/owner/private.mp3',
  voiceFilePath:'/private/legacy.mp3',caption:'',annotations:[]
 }]});
 h.table('inspection_items').set('legacy-voice-item',{_id:'legacy-voice-item',inspectionId,projectId:'p',sourcePhotoId:'legacy-photo',sortOrder:0,deleted:false,description:'人工确认：墙角收口存在待处理缝隙。',sourceQuote:'原始转写：墙角可能有裂缝，请核对。',aiRawResult:{private:'hidden'}});
 h.table('reports').set(reportId,{_id:reportId,projectId:'p',inspectionId,shareToken:token,shareState:'active',title:'历史报告',deleted:false});
 h.as('recipient');
 const shared=await h.load('report')({action:'detail',payload:{reportId,shareToken:token}});
 assert.equal(shared.success,true);
 assert.equal(shared.data.photos[0].caption,'','a legacy source transcript is not a human-authored photo caption');
 assert.equal(JSON.stringify(shared.data).includes('原始转写'),false,'source transcript must not leak as duplicated shared text');
 assert.equal(JSON.stringify(shared.data).includes('private.mp3'),false,'recording references must never be shared by default');
 assert.equal(shared.data.photos[0].voiceText,undefined);
 assert.equal(shared.data.photos[0].voiceStorageFileId,undefined);
 assert.equal(shared.data.items[0].sourceQuote,undefined);
 assert.equal(shared.data.items[0].aiRawResult,undefined);
});
test('project gallery reads photo-level evidence, including zero-issue photos, without duplicating same-photo issues',async()=>{
 const h=fixture(),p=payload();p.items=[];
 const inspection=await h.load('inspection')({action:'confirm',payload:p});
 const gallery=await h.load('project')({action:'gallery',payload:{projectId:'p'}});
 assert.equal(gallery.success,true);
 assert.equal(gallery.data.photos.length,2);
 assert.equal(gallery.data.photos.map(photo=>photo.imageUrl).join('|'),
  'cloud://env/inspection-images/user/owner/a.png|cloud://env/inspection-images/user/owner/b.png');
 assert.equal(gallery.data.photos[0].inspectionId,inspection.data.inspectionId);
});
test('first-run placeholder is not published as a real inspector or publisher name',async()=>{
 const h=fixture(),auth=h.load('auth');
 const initialized=await auth({action:'initSession'});
 assert.equal(initialized.data.nickname,'');
 const roleOnly=await auth({action:'updateProfile',payload:{nickname:'巡查员'}});
 assert.equal(roleOnly.success,false);
 const saved=await auth({action:'updateProfile',payload:{nickname:'现场张工'}});
 assert.equal(saved.data.nickname,'现场张工');
});

test('privacy rights requests are identity-bound, auditable and never reported as completed on submission',async()=>{
 const h=fixture(),auth=h.load('auth');
 const payload={requestId:'privacy-request-0001',requestType:'注销账号',details:'请核实并告知处理结果',openId:'attacker'};
 const submitted=await auth({action:'submitPrivacyRequest',payload});
 assert.equal(submitted.success,true);
 assert.equal(submitted.data.status,'received');
 const saved=[...h.table('privacy_requests').values()][0];
 assert.equal(saved.openId,'owner','the requester identity comes from the trusted WeChat context, not the client payload');
 assert.equal(saved.details,'请核实并告知处理结果');
 assert.equal(saved.status,'received','request intake is not falsely marked as completed');
 await auth({action:'submitPrivacyRequest',payload:{...payload,requestId:'privacy-request-0002',requestType:'非法申请',details:'x'}}).then(result=>assert.equal(result.success,false));
 const retry=await auth({action:'submitPrivacyRequest',payload});
 assert.equal(retry.data._id,submitted.data._id,'retry after a lost network response is idempotent');
 assert.equal(h.table('privacy_requests').size,1);
 h.as('another-user');
 const own=await auth({action:'listPrivacyRequests'});
 assert.deepEqual(own.data,[],'another identity cannot inspect the first user request');
 h.as('owner');
 const list=await auth({action:'listPrivacyRequests'});
 assert.equal(list.data.length,1);
 assert.equal(list.data[0].openId,undefined,'request listing does not expose the internal account identifier');
});
test('legacy company settings without deleted remain visible, update in place, and enter report snapshots',async()=>{
 const h=fixture();
 h.table('app_settings').set('legacy',{_id:'legacy',openId:'owner',companyName:'旧公司资料',companyPhone:'010-12345678',logoFileId:'cloud://env/logos/user/owner/legacy.png',reportPdfEngine:'legacy',reportPdfServiceUrl:'https://legacy.example',updatedAt:10});
 h.table('app_settings').set('removed',{_id:'removed',openId:'owner',companyName:'已删除资料',deleted:true,updatedAt:20});
 const settings=h.load('settings');
 const before=await settings({action:'detail'});
 assert.equal(before.data._id,'legacy');
 assert.equal(before.data.logoFileId,'cloud://env/logos/user/owner/legacy.png');
 const saved=await settings({action:'save',payload:{companyName:'恢复后的公司资料',companyPhone:'010-87654321',logoFileId:'cloud://env/logos/user/owner/recovered.png'}});
 assert.equal(saved.data._id,'legacy');
 assert.equal(saved.data.deleted,false);
 assert.equal(saved.data.reportPdfEngine,'legacy','saving company details preserves dormant legacy settings without activating them');
 assert.equal(saved.data.reportPdfServiceUrl,'https://legacy.example');
 assert.equal(h.table('app_settings').size,2);
 h.table('users').set('u',{openId:'owner',nickname:'巡查员',deleted:false});
 const confirm=h.load('inspection');
 const p=payload();p.items=[];
 const inspection=await confirm({action:'confirm',payload:p});
 const report=h.load('report');
 const built=await report({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 assert.equal(built.data.inspectorName,'','the old generic placeholder must not imply a named inspector');
 assert.equal(built.data.companyName,'恢复后的公司资料');
 assert.equal(built.data.companyPhone,'010-87654321');
 assert.equal(built.data.logoFileId,'cloud://env/logos/user/owner/recovered.png');
 h.table('users').get('u').nickname='现场张工';
 const explicitlyNamed=await report({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 assert.equal(explicitlyNamed.data.inspectorName,'现场张工');
});

test('online-only report cloud API no longer dispatches PDF create or polling actions',async()=>{
 const h=fixture(),report=h.load('report');
 const create=await report({action:'createPdfTask',payload:{reportId:'report-not-created'}});
 const poll=await report({action:'getPdfTaskStatus',payload:{reportId:'report-not-created',taskId:'legacy-task'}});
 assert.equal(create.success,false);
 assert.equal(poll.success,false);
 assert.equal(create.message,'未知操作');
 assert.equal(poll.message,'未知操作');
 assert.equal(h.table('reports').size,0,'disabled calls must not create reports or mutate historical records');
});

test('legacy user without deleted flag remains the inspector and publisher in the frozen share',async()=>{
 const h=fixture();
 h.table('users').set('legacy-user',{_id:'legacy-user',openId:'owner',nickname:'陈工',phone:'13800000000',updatedAt:10});
 h.table('users').set('removed-user',{_id:'removed-user',openId:'owner',nickname:'已删除账号',deleted:true,updatedAt:20});
 const p=payload();p.items=[];
 const inspection=await h.load('inspection')({action:'confirm',payload:p});
 const report=h.load('report');
 const built=await report({action:'build',payload:{inspectionId:inspection.data.inspectionId}});
 assert.equal(built.data.inspectorName,'陈工');
 assert.equal(built.data.inspectorPhone,'13800000000');
 const published=await report({action:'save',payload:{...built.data,requestId:'legacy-user-share'}});
 assert.equal(published.data.snapshot.publisherName,'陈工');
 assert.equal(published.data.snapshot.publisherPhone,'13800000000');
 h.as('recipient');
 const shared=await report({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
 assert.equal(shared.data.publisherName,'陈工');
 assert.equal(shared.data.inspectorName,'陈工');
});

test('legacy account without deleted flag is reused instead of creating a duplicate profile',async()=>{
 const h=fixture(),auth=h.load('auth');
 h.table('users').set('legacy',{_id:'legacy',openId:'owner',nickname:'历史巡查人',phone:'13800000001',updatedAt:10});
 const initialized=await auth({action:'initSession'});
 assert.equal(initialized.data._id,'legacy');
 assert.equal(initialized.data.nickname,'历史巡查人');
 assert.equal(h.table('users').size,1);
 const saved=await auth({action:'updateProfile',payload:{phone:'13800000002'}});
 assert.equal(saved.data._id,'legacy');
 assert.equal(saved.data.nickname,'历史巡查人');
 assert.equal(saved.data.phone,'13800000002');
 assert.equal(h.table('users').size,1);
});

test('same WeChat identity re-entry restores cloud projects, inspections and reports while another identity stays isolated',async()=>{
 const h=fixture(),auth=h.load('auth');
 h.table('users').set('owner-user',{_id:'owner-user',openId:'owner',nickname:'张工',deleted:false});
 h.table('projects').set('owner-project',{_id:'owner-project',name:'云端项目',ownerOpenId:'owner',deleted:false,updatedAt:30});
 h.table('inspections').set('owner-inspection',{_id:'owner-inspection',projectId:'owner-project',title:'已提交巡查',status:'submitted',deleted:false,createdAt:20});
 h.table('reports').set('owner-report',{_id:'owner-report',projectId:'owner-project',inspectionId:'owner-inspection',title:'云端报告',deleted:false,publishedAt:10,createdAt:10});

 const first=await auth({action:'initSession'});
 const projects=h.load('project'),inspections=h.load('inspection'),reports=h.load('report');
 const firstProjectList=await projects({action:'list',payload:{page:1,pageSize:20}});
 const firstInspectionList=await inspections({action:'list',payload:{projectId:'owner-project',page:1,pageSize:20}});
 const firstReportList=await reports({action:'list',payload:{page:1,pageSize:20}});
 assert.equal(firstProjectList.data.list.some(row=>row._id==='owner-project'),true);
 assert.equal(firstInspectionList.data.list[0]._id,'owner-inspection');
 assert.equal(firstReportList.data.list.some(row=>row._id==='owner-report'),true);

 const returned=await auth({action:'initSession'});
 assert.equal(returned.data._id,first.data._id,'returning under the same WeChat identity reuses the same profile');
 assert.equal(h.table('users').size,1,'re-entry must not create a duplicate user record');
 assert.equal((await projects({action:'list',payload:{page:1,pageSize:20}})).data.list.some(row=>row._id==='owner-project'),true);
 assert.equal((await inspections({action:'list',payload:{projectId:'owner-project',page:1,pageSize:20}})).data.list[0]._id,'owner-inspection');
 assert.equal((await reports({action:'list',payload:{page:1,pageSize:20}})).data.list.some(row=>row._id==='owner-report'),true);

 h.as('different-wechat-user');
 const other=await auth({action:'initSession'});
 assert.notEqual(other.data._id,first.data._id);
 assert.equal((await projects({action:'list',payload:{page:1,pageSize:20}})).data.list.length,0);
 assert.equal((await inspections({action:'list',payload:{page:1,pageSize:20}})).data.list.length,0);
 assert.equal((await reports({action:'list',payload:{page:1,pageSize:20}})).data.list.length,0);
});

test('an existing report share stays readable when its owner project is no longer active',async()=>{
 const h=fixture(),inspection=h.load('inspection'),reports=h.load('report');
 const created=await inspection({action:'confirm',payload:{requestId:'account-close-shared-report',form:{projectId:'p',title:'注销后仍可阅读的已分享报告',issueDrafts:[{id:'photo-shared',imagePath:'cloud://env/inspection-images/user/owner/shared.png'}]},items:[]}});
 const built=await reports({action:'build',payload:{inspectionId:created.data.inspectionId}});
 const published=await reports({action:'save',payload:{...built.data,requestId:'account-close-share-publish'}});
 const activeToken=published.data.shareToken;

 // Account closure may deactivate private project access, but must not revoke or delete an existing shared snapshot.
 h.table('projects').get('p').deleted=true;
 h.as('recipient');
 const read=await reports({action:'detail',payload:{reportId:published.data._id,shareToken:activeToken}});
 assert.equal(read.success,true);
 assert.equal(read.data.accessMode,'shared');
 assert.equal(read.data.photos.length,1,'the frozen snapshot and its evidence remain readable');
 assert.equal(read.data.shareToken,undefined,'the reader never receives the bearer token back');
 assert.equal(h.table('reports').get(published.data._id).shareToken,activeToken,'owner deactivation must not mutate the active link');
});

test('legacy project and report records without deleted flag remain visible in owner lists',async()=>{
 const h=fixture();
 h.table('projects').set('legacy-project',{_id:'legacy-project',name:'历史项目',ownerOpenId:'owner',updatedAt:10});
 h.table('reports').set('legacy-report',{_id:'legacy-report',projectId:'legacy-project',title:'历史项目巡查报告',publishedAt:20,createdAt:20});
 h.table('inspections').set('legacy-inspection',{_id:'legacy-inspection',projectId:'legacy-project',title:'历史巡查',createdAt:15});
 const projects=await h.load('project')({action:'list',payload:{page:1,pageSize:20}});
 assert.equal(projects.data.list.some(item=>item._id==='legacy-project'),true);
 const inspections=await h.load('inspection')({action:'list',payload:{projectId:'legacy-project',page:1,pageSize:20}});
 assert.equal(inspections.data.list[0]._id,'legacy-inspection');
 const reports=await h.load('report')({action:'list',payload:{projectId:'legacy-project',page:1,pageSize:20}});
 assert.equal(reports.data.list[0]._id,'legacy-report');
 h.table('inspections').set('legacy-built-inspection',{_id:'legacy-built-inspection',projectId:'legacy-project',title:'历史可重开巡查',inspectionDate:12,inspectorOpenId:'owner',status:'submitted'});
 h.table('inspection_items').set('legacy-built-item',{_id:'legacy-built-item',inspectionId:'legacy-built-inspection',projectId:'legacy-project',sortOrder:0,description:'历史问题',images:[],annotatedImages:[]});
 const built=await h.load('report')({action:'build',payload:{inspectionId:'legacy-built-inspection'}});
 assert.equal(built.data.items[0].description,'历史问题');
});

test('the project client contact reaches the report snapshot and the share reader',async()=>{
 const h=fixture();
 h.table('projects').get('p').clientName='陈工';
 h.table('projects').get('p').clientPhone='13800000009';
 h.table('users').set('u',{openId:'owner',nickname:'张工',phone:'13900000000',deleted:false});
 h.table('app_settings').set('s',{openId:'owner',companyName:'示例市示例家具有限公司',deleted:false});
 const confirm=h.load('inspection');
 const insp=await confirm({action:'confirm',payload:payload()});
 const report=h.load('report');
 const built=await report({action:'build',payload:{inspectionId:insp.data.inspectionId}});
 assert.equal(built.data.clientName,'陈工','甲方联系人要能被报告构建读到');
 assert.equal(built.data.clientPhone,'13800000009');

 const published=await report({action:'save',payload:{...built.data,requestId:'client-contact'}});
 assert.equal(published.success,true);
 assert.equal(published.data.snapshot.clientName,'陈工','甲方信息要冻进快照');
 assert.equal(published.data.snapshot.clientPhone,'13800000009');

 // 只读接收者也必须看得到：报告是发给施工方与业主双方的。
 h.as('recipient');
 const read=await report({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
 assert.equal(read.success,true);
 assert.equal(read.data.accessMode,'shared');
 assert.equal(read.data.clientName,'陈工','读者字段白名单不能把甲方信息挡掉');
 assert.equal(read.data.clientPhone,'13800000009');
});

test('a project without a client contact adds no client fields to the report',async()=>{
 const h=fixture();
 h.table('users').set('u',{openId:'owner',nickname:'张工',deleted:false});
 const confirm=h.load('inspection');
 const insp=await confirm({action:'confirm',payload:payload()});
 const report=h.load('report');
 const built=await report({action:'build',payload:{inspectionId:insp.data.inspectionId}});
 assert.equal(built.data.clientName,'');
 assert.equal(built.data.clientPhone,'');
});
