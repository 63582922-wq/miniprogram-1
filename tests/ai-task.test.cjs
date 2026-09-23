const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
function fixture(post){const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test'},modules:{axios:{post},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},console:{log(){},warn(){},error(){}}});return {h,fn};}
const response=items=>({data:{choices:[{message:{content:JSON.stringify({items})}}]}});
function input(count=1){return {requestId:'ai-1',inputVersion:1,projectId:'p',issueDrafts:Array.from({length:count},(_,i)=>({id:'p'+i,imagePath:'cloud://env/inspection-images/user/owner/p'+i+'.png'}))};}
test('AI create/read are free of model calls; completed empty result is durable; concurrent advance is leased',async()=>{
 let calls=0;const {h,fn}=fixture(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return response([]);});
 const r=await fn({action:'createInspectionTask',payload:input()});assert.equal(r.success,true);const id=r.data.taskId;
 const again=await fn({action:'createInspectionTask',payload:input()});assert.equal(again.data.taskId,id);assert.equal(calls,0);
 await fn({action:'readInspectionTaskStatus',payload:{taskId:id}});assert.equal(calls,0);
 await Promise.all([1,2,3].map(()=>fn({action:'advanceInspectionTask',payload:{taskId:id}})));assert.equal(calls,1);
 const complete=await fn({action:'readInspectionTaskStatus',payload:{taskId:id}});assert.equal(complete.data.status,'success');assert.equal(complete.data.analysis.items.length,0);
 await fn({action:'advanceInspectionTask',payload:{taskId:id}});assert.equal(calls,1);
 h.as('someone-else');assert.equal((await fn({action:'readInspectionTaskStatus',payload:{taskId:id}})).success,false);
});
test('AI partial success is checkpointed; retry only reprocesses failed input',async()=>{
 const counts=[0,0,0];let fail=true;
 const {h,fn}=fixture(async(_url,body)=>{const txt=JSON.stringify(body),i=[0,1,2].find(i=>txt.includes('p'+i+'.png'));counts[i]++;
   if(i===1&&fail){fail=false;throw Error('simulated model failure');}return response([{sourceIndex:0,description:'缺陷'+i}]);});
 const r=await fn({action:'createInspectionTask',payload:input(3)}),id=r.data.taskId;
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId:id}});assert.equal(failed.data.status,'failed');assert.equal(failed.data.completedBatches,2);
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:id}});assert.equal(done.data.status,'success');assert.deepEqual(counts,[1,2,1]);
 assert.equal(done.data.analysis.items.length,3);assert.equal(new Set(done.data.analysis.items.map(i=>i.sourcePhotoId)).size,3);
});
