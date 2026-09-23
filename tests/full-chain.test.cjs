const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {harness}=require('./cloud-harness.cjs');

test('full inspection delivery chain: project to immutable report, reader share and recoverable PDF task',async()=>{
  const h=harness();
  const project=h.load('project');
  const created=await project({action:'create',payload:{requestId:'project-e2e-1',name:'全链路隔离项目',address:'测试地址'}});
  assert.equal(created.success,true);
  const projectId=created.data._id;

  const inspection=h.load('inspection');
  const confirm=await inspection({action:'confirm',payload:{requestId:'inspection-e2e-1',form:{projectId,issueDrafts:[
    {id:'photo-1',imagePath:'cloud://test/inspection-images/user/owner/one.png',voiceText:'窗边收口需核对'},
    {id:'photo-2',imagePath:'cloud://test/inspection-images/user/owner/two.png'}
  ]},items:[
    {id:'issue-1',sourcePhotoId:'photo-1',sourceIndex:0,description:'窗边收口不平整',suggestion:'现场复核并修整',severity:'major'},
    {id:'issue-2',sourcePhotoId:'photo-1',sourceIndex:0,description:'胶缝需补齐',severity:'normal'}
  ]}});
  assert.equal(confirm.success,true);
  const inspectionId=confirm.data.inspectionId;

  const report=h.load('report');
  const built=await report({action:'build',payload:{inspectionId}});
  const published=await report({action:'save',payload:{...built.data,requestId:'report-e2e-1'}});
  assert.equal(published.success,true);
  const reportId=published.data._id;
  assert.equal(published.data.snapshot.photos.length,2);
  assert.equal(published.data.snapshot.items.filter(i=>i.sourcePhotoId==='photo-1').length,2);

  h.as('recipient');
  const reader=await report({action:'detail',payload:{reportId,shareToken:published.data.shareToken}});
  assert.equal(reader.success,true);
  assert.equal(reader.data.accessMode,'shared');
  assert.equal(reader.data.items.length,2);
  assert.equal(reader.data.shareToken,undefined);
  h.as('owner');

  let postCount=0;
  const network={request(_url,options,callback){let body='';const req=new EventEmitter();req.write=value=>body+=value;req.destroy=error=>req.emit('error',error);req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;callback(res);if(options.method==='POST')postCount+=1;const taskId=options.method==='POST'?JSON.parse(body).jobId:'pdf-unknown';res.emit('data',Buffer.from(JSON.stringify({success:true,data:{taskId,status:'queued'}})));res.emit('end');});return req;}};
  const reportWithPdf=h.load('report',{modules:{https:network,http:network}});
  const pdf=await reportWithPdf({action:'createPdfTask',payload:{reportId}});
  assert.equal(pdf.success,true);
  assert.match(pdf.data.taskId,/^pdf-[a-f0-9]{40}$/);
  await reportWithPdf({action:'createPdfTask',payload:{reportId}});
  assert.equal(postCount,1);

  const unchanged=await report({action:'detail',payload:{reportId}});
  assert.equal(unchanged.data.snapshot.items[0].description,'窗边收口不平整');
  await report({action:'revokeShareToken',payload:{reportId}});
  h.as('recipient');
  const revoked=await report({action:'detail',payload:{reportId,shareToken:published.data.shareToken}});
  assert.equal(revoked.success,false);
});
