const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');

test('spoken field details survive text organization, confirmation, frozen report and read-only reopen',async()=>{
  const h=harness();
  const project=await h.load('project')({action:'create',payload:{requestId:'text-report-project',name:'文字字段隔离项目',address:'示例测试地址'}});
  assert.equal(project.success,true);
  const photo={id:'photo-text-1',imagePath:'cloud://test/inspection-images/user/owner/text-photo.png',voiceText:'次卧窗台收口缺胶，由木作班组负责补胶。',annotations:[
    {id:'point-text-1',type:'point',a:{x:.2,y:.3},b:{x:.25,y:.35}}
  ]};
  photo.voiceText='窗台收口处需要补胶。区域：次卧窗台；分类：木作；责任方：木作班组（待现场确认）；处理建议：补胶后复查。';
  // Exercise the production source-grounding path with explicit responsibility
  // text, while simulating a model that omits all optional fields.
  const organized=normalizeTextItems(photo,[{sourceQuote:photo.voiceText}]);
  assert.equal(organized.length,1);
  assert.equal(organized[0].area,'次卧窗台');
  assert.equal(organized[0].category,'木作');
  assert.equal(organized[0].responsiblePartyName,'木作班组');
  assert.equal(organized[0].suggestion,'','text organization must not invent or extract treatment recommendations');

  const confirmed=await h.load('inspection')({action:'confirm',payload:{
    requestId:'text-report-inspection',
    form:{projectId:project.data._id,issueDrafts:[photo]},
    items:organized,
    originalItems:organized
  }});
  assert.equal(confirmed.success,true);
  // Simulate an older or partially enriched child row containing AI-side
  // diagnostics. None of those fields belong in the durable report snapshot.
  for(const [id,row] of h.table('inspection_items')) if(row.inspectionId===confirmed.data.inspectionId){
    h.table('inspection_items').set(id,{...row,sourceQuote:photo.voiceText,originalText:photo.voiceText,
      fieldEvidence:{area:'内部依据'},textOrganized:true,needsReview:true,confidence:'low',visualEvidence:'内部识图注释',
      aiRawResult:{providerPayload:'private'},voiceFilePath:'/private/audio.mp3',privateFutureField:'private'});
  }
  const inspectionRow=h.table('inspections').get(confirmed.data.inspectionId);
  inspectionRow.photos[0].annotations[0].privateNote='internal marker note';
  h.table('inspections').set(confirmed.data.inspectionId,inspectionRow);
  const report= h.load('report');
  const built=await report({action:'build',payload:{inspectionId:confirmed.data.inspectionId}});
  assert.equal(built.success,true);
  const published=await report({action:'save',payload:{...built.data,requestId:'text-report-publication'}});
  assert.equal(published.success,true);
  const snapshotItem=published.data.snapshot.items[0];
  for(const [field,value] of Object.entries({area:'次卧窗台',category:'木作',responsiblePartyName:'木作班组',suggestion:''})){
    assert.equal(snapshotItem[field],value,`published snapshot must preserve ${field}`);
  }
  for(const field of ['fieldEvidence','sourceQuote','originalText','textOrganized','needsReview','confidence','visualEvidence','aiRawResult','voiceFilePath','privateFutureField']){
    assert.equal(snapshotItem[field],undefined,`${field} is internal and must not enter the published snapshot`);
  }
  assert.equal(JSON.stringify(published.data.snapshot.photos[0].annotations[0]),JSON.stringify({
    id:'point-text-1',type:'point',a:{x:.2,y:.3},b:{x:.25,y:.35}
  }));

  h.as('text-report-recipient');
  const reopened=await report({action:'detail',payload:{reportId:published.data._id,shareToken:published.data.shareToken}});
  assert.equal(reopened.success,true);
  for(const [field,value] of Object.entries({area:'次卧窗台',category:'木作',responsiblePartyName:'木作班组',suggestion:''})){
    assert.equal(reopened.data.items[0][field],value,`read-only report must preserve ${field}`);
  }
  assert.equal(reopened.data.items[0].fieldEvidence,undefined);
});

test('full inspection delivery chain: project to immutable online report, reader share and revoke',async()=>{
  const h=harness();
  const project=h.load('project');
  const created=await project({action:'create',payload:{requestId:'project-e2e-1',name:'全链路隔离项目',address:'测试地址'}});
  assert.equal(created.success,true);
  const projectId=created.data._id;

  const inspection=h.load('inspection');
  const confirm=await inspection({action:'confirm',payload:{requestId:'inspection-e2e-1',form:{projectId,issueDrafts:[
    {id:'photo-1',imagePath:'cloud://test/inspection-images/user/owner/one.png',voiceText:'窗边收口需核对'},
    {id:'photo-2',imagePath:'cloud://test/inspection-images/user/owner/two.png',caption:'照片级补充：该处需在复查时观察。'}
  ]},items:[
    {id:'issue-1',sourcePhotoId:'photo-1',sourceIndex:0,description:'窗边收口不平整',suggestion:'现场复核并修整',severity:'major'},
    {id:'issue-2',sourcePhotoId:'photo-1',sourceIndex:0,description:'胶缝需补齐',severity:'normal'}
  ]}});
  assert.equal(confirm.success,true);
  const inspectionId=confirm.data.inspectionId;

  // AI observations are review aids, never report content. Simulate a legacy
  // row that accidentally retained analysis and prove publication strips it.
  const inspectionRow=h.table('inspections').get(inspectionId);
  inspectionRow.analysis={observations:[{sourcePhotoId:'photo-1',text:'内部 AI 观察，不应出现在报告'}]};
  h.table('inspections').set(inspectionId,inspectionRow);

  const report=h.load('report');
  const built=await report({action:'build',payload:{inspectionId}});
  const published=await report({action:'save',payload:{...built.data,requestId:'report-e2e-1'}});
  assert.equal(published.success,true);
  const reportId=published.data._id;
  assert.equal(published.data.snapshot.analysis,undefined);
  assert.equal(published.data.snapshot.observations,undefined);
  assert.equal(JSON.stringify(published.data.snapshot).includes('内部 AI 观察'),false);
  assert.equal(published.data.snapshot.photos.length,2);
  assert.equal(published.data.snapshot.photos[0].caption,'','spoken source text must not be repeated as a photo caption');
  assert.equal(published.data.snapshot.photos[1].caption,'照片级补充：该处需在复查时观察。','explicit photo-level notes remain visible');
  assert.equal(published.data.snapshot.items.filter(i=>i.sourcePhotoId==='photo-1').length,2);

  h.as('recipient');
  const reader=await report({action:'detail',payload:{reportId,shareToken:published.data.shareToken}});
  assert.equal(reader.success,true);
  assert.equal(reader.data.accessMode,'shared');
  assert.equal(reader.data.items.length,2);
  assert.equal(reader.data.photos[0].caption,'','read-only report must not reintroduce the spoken source text as a caption');
  assert.equal(reader.data.photos[1].caption,'照片级补充：该处需在复查时观察。');
  assert.equal(reader.data.analysis,undefined);
  assert.equal(JSON.stringify(reader.data).includes('内部 AI 观察'),false);
  assert.equal(reader.data.shareToken,undefined);
  for(const action of ['revokeShareToken','createShareToken']){
    const denied=await report({action,payload:{reportId,shareToken:published.data.shareToken,rotate:true}});
    assert.equal(denied.success,false,'a valid read token must never authorize link management');
  }
  h.as('owner');

  const unchanged=await report({action:'detail',payload:{reportId}});
  assert.equal(unchanged.data.snapshot.items[0].description,'窗边收口不平整');
  await report({action:'revokeShareToken',payload:{reportId}});
  h.as('recipient');
  const revoked=await report({action:'detail',payload:{reportId,shareToken:published.data.shareToken}});
  assert.equal(revoked.success,false);
});
