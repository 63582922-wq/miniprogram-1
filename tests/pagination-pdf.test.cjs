const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {harness}=require('./cloud-harness.cjs');
test('project/report paging covers beyond 100 rows and sorts by publication, not PDF generation',async()=>{
 const h=harness();for(let i=0;i<125;i++){const id='p'+i;h.table('projects').set(id,{_id:id,name:id,ownerOpenId:'owner',deleted:false,updatedAt:i});h.table('reports').set('r'+i,{_id:'r'+i,projectId:id,deleted:false,title:id,publishedAt:i,createdAt:i,generatedAt:1000-i});}
 const p=h.load('project'),r=h.load('report'),projects=[],reports=[];
 for(let page=1;page<=7;page++){projects.push(...(await p({action:'list',payload:{page,pageSize:20}})).data.list);reports.push(...(await r({action:'list',payload:{page,pageSize:20}})).data.list);}
 assert.equal(new Set(projects.map(p=>p._id)).size,125);assert.equal(new Set(reports.map(p=>p._id)).size,125);assert.equal(reports[0]._id,'r124');assert.equal(reports[124]._id,'r0');
 h.as('other');assert.equal((await r({action:'list',payload:{projectId:'p0'}})).success,false);
});
test('inspection history is paged, ordered and never reports a failed request as empty',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});
 for(let i=0;i<125;i++)h.table('inspections').set('i'+i,{_id:'i'+i,projectId:'p',deleted:false,status:'submitted',createdAt:i});
 h.table('inspections').set('preparing',{_id:'preparing',projectId:'p',deleted:false,status:'preparing',createdAt:999});
 const fn=h.load('inspection'),rows=[];
 for(let page=1;page<=7;page++)rows.push(...(await fn({action:'list',payload:{projectId:'p',page,pageSize:20}})).data.list);
 assert.equal(rows.length,125);assert.equal(new Set(rows.map(row=>row._id)).size,125);assert.equal(rows[0]._id,'i124');assert.equal(rows[124]._id,'i0');
 assert.equal((await fn({action:'list',payload:{projectId:'p'}})).data.list.length,125);
 h.as('other');assert.equal((await fn({action:'list',payload:{projectId:'p'}})).success,false);
});
test('project request survives response-loss retry and refuses conflicting content',async()=>{
 const h=harness(),p=h.load('project'),payload={requestId:'one',name:'隔离项目'};
 const a=await p({action:'create',payload}),b=await p({action:'create',payload});assert.equal(a.data._id,b.data._id);assert.equal(h.table('projects').size,1);
 await assert.rejects(p({action:'create',payload:{...payload,name:'变更'}}),/内容已变化/);
});
test('PDF task is recorded before dispatch; lost/restarted service fails explicitly and can retry',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});h.table('reports').set('r',{_id:'r',projectId:'p',deleted:false,snapshotVersion:2,snapshot:{title:'测试',items:[],photos:[]}});
 let posts=0,missing=false;
 const net={request(url,opts,callback){let body='';const req=new EventEmitter();req.write=b=>body+=b;req.destroy=e=>req.emit('error',e);req.end=()=>queueMicrotask(()=>{
   const response=new EventEmitter();response.statusCode=missing?404:200;callback(response);
   if(opts.method==='POST')posts++;
   const data=opts.method==='POST'?{taskId:JSON.parse(body).jobId,status:'queued'}:{status:'running'};
   response.emit('data',Buffer.from(JSON.stringify(missing?{success:false,message:'PDF任务不存在'}:{success:true,data})));response.emit('end');
 });return req;}};
 const fn=h.load('report',{modules:{https:net,http:net}});
 const a=await fn({action:'createPdfTask',payload:{reportId:'r'}}),b=await fn({action:'createPdfTask',payload:{reportId:'r'}});
 assert.equal(posts,1);assert.equal(a.data.taskId,b.data.taskId);
 missing=true;h.table('reports').get('r').pdfTaskStartedAt=Date.now()-60000;
 const failed=await fn({action:'getPdfTaskStatus',payload:{reportId:'r',taskId:a.data.taskId}});assert.equal(failed.data.taskStatus,'failed');
 missing=false;const retry=await fn({action:'createPdfTask',payload:{reportId:'r'}});assert.notEqual(retry.data.taskId,a.data.taskId);assert.equal(posts,2);
});
