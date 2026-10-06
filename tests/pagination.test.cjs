const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
test('project/report paging covers beyond 100 rows and sorts by publication time',async()=>{
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
