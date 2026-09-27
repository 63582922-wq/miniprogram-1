const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
function fixture(post){const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test'},modules:{axios:{post},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},console:{log(){},warn(){},error(){}}});return {h,fn};}
const response=items=>({data:{choices:[{message:{content:JSON.stringify({items})}}]}});
function input(count=1){return {requestId:'ai-1',inputVersion:1,projectId:'p',issueDrafts:Array.from({length:count},(_,i)=>({id:'p'+i,imagePath:'cloud://env/inspection-images/user/owner/p'+i+'.png'}))};}
test('runtime status exposes capability but never credentials',async()=>{
 const {fn}=fixture(async()=>response([]));
 const result=await fn({action:'getRuntimeStatus'});
 assert.equal(result.success,true);assert.equal(result.data.visionEnabled,true);assert.equal(result.data.model,'test');
 assert.equal(result.data.batchSize,1);assert.equal(result.data.parallelLimit,3);assert.equal(result.data.maxPhotos,20);
 assert.equal(JSON.stringify(result.data).includes('isolated-test'),false);
});
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
   if(i===1&&fail){fail=false;throw Error('simulated model failure');}return response([{sourceIndex:0,description:'缺陷'+i,visualEvidence:'照片可见缺陷'+i,evidenceSource:'image'}]);});
 const r=await fn({action:'createInspectionTask',payload:input(3)}),id=r.data.taskId;
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId:id}});assert.equal(failed.data.status,'failed');assert.equal(failed.data.completedBatches,2);
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:id}});assert.equal(done.data.status,'success');assert.deepEqual(counts,[1,2,1]);
 assert.equal(done.data.analysis.items.length,3);assert.equal(new Set(done.data.analysis.items.map(i=>i.sourcePhotoId)).size,3);
});

test('transcribed or typed findings skip duplicate image recognition by default',async()=>{
 let calls=0;
 const {fn}=fixture(async()=>{calls++;return response([]);});
 const payload=input();payload.issueDrafts[0].voiceText='吊顶边缘已经开裂，需要复核';
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(calls,0,'manual findings must not spend vision quota');
 assert.equal(done.data.completedPhotos,0);
 assert.equal(done.data.analysis.aiMode,'manual');
 assert.equal(done.data.analysis.items.length,1);
 assert.equal(done.data.analysis.items[0].confidence,'low');
 assert.equal(done.data.analysis.items[0].needsReview,true);
 assert.equal(done.data.analysis.items[0].evidenceSource,'note');
});

test('the user can explicitly request AI image recognition even when a note exists',async()=>{
 let requestBody;
 const {fn}=fixture(async(_url,body)=>{requestBody=body;return response([{sourceIndex:0,description:'吊顶板边缘存在待核对缝隙',visualEvidence:'板材边缘可见连续缝隙',evidenceSource:'image+note',confidence:'low',needsReview:true}]);});
 const payload=input();payload.issueDrafts[0].voiceText='这里看一下缝隙';payload.issueDrafts[0].analysisMode='ai';
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 const userContent=requestBody.messages.find(message=>message.role==='user').content;
 assert.equal(userContent.some(part=>part.type==='image_url'),true);
 assert.equal(done.data.analysis.items[0].evidenceSource,'image+note');
});

test('inspection questions do not become defects and image claims without evidence are discarded',async()=>{
 const {fn}=fixture(async()=>response([{sourceIndex:0,description:'疑似开裂',evidenceSource:'image',confidence:'high',visualEvidence:''}]));
 const payload=input();payload.issueDrafts[0].voiceText='请查看吊顶边缘，判断是否存在开裂或收口不完整';
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');
 assert.equal(done.data.analysis.items.length,0);
 assert.match(done.data.analysis.summary,/未整理出可确认的问题项/);
});

test('explicit field assertions survive without visual evidence but are forced to low confidence review',async()=>{
 const {fn}=fixture(async()=>response([]));
 const payload=input();payload.issueDrafts[0].voiceText='窗框右侧收口不平整，需要补胶';
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.analysis.items.length,1);
 assert.equal(done.data.analysis.items[0].evidenceSource,'note');
 assert.equal(done.data.analysis.items[0].confidence,'low');
 assert.equal(done.data.analysis.items[0].needsReview,true);
});

test('legacy synchronous analysis keeps the same explicit-note safety contract',async()=>{
 const {fn}=fixture(async()=>response([]));
 const payload=input();payload.issueDrafts[0].voiceText='墙面右侧已经开裂，需要复核';
 const result=await fn({action:'analyzeInspection',payload});
 assert.equal(result.success,true);
 assert.equal(result.data.items.length,1);
 assert.equal(result.data.items[0].evidenceSource,'note');
 assert.equal(result.data.items[0].needsReview,true);
});

test('a text-only fallback cannot pretend it inspected a photo when vision is not configured',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{},modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},console:{log(){},warn(){},error(){}}});
 const created=await fn({action:'createInspectionTask',payload:input()});
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(failed.data.status,'failed');
 assert.match(failed.data.errorMessage,/未配置支持图片分析的模型/);
 assert.equal(failed.data.completedPhotos,0);
});

test('provider billing errors become actionable Chinese copy without leaking transport details',async()=>{
 const billingError=Error('Request failed with status code 402');billingError.response={status:402};
 const {fn}=fixture(async()=>{throw billingError;});
 const created=await fn({action:'createInspectionTask',payload:input()});
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(failed.data.status,'failed');
 assert.match(failed.data.errorMessage,/额度暂时不足/);
 assert.doesNotMatch(failed.data.errorMessage,/402|Request failed/);
});

test('parallel multi-photo analysis checkpoints each finished photo for read-only live progress',async()=>{
 let releaseSlow,firstReturned;
 const slowGate=new Promise(resolve=>{releaseSlow=resolve});
 const firstSeen=new Promise(resolve=>{firstReturned=resolve});
 const {fn}=fixture(async(_url,body)=>{
   const text=JSON.stringify(body),index=[0,1,2].find(i=>text.includes('p'+i+'.png'));
   if(index===0){firstReturned();return response([{sourceIndex:0,description:'问题0',visualEvidence:'可见问题0',confidence:'high'}]);}
   await slowGate;
   return response([{sourceIndex:0,description:'问题'+index,visualEvidence:'可见问题'+index,confidence:'high'}]);
 });
 const created=await fn({action:'createInspectionTask',payload:input(3)}),id=created.data.taskId;
 const advancing=fn({action:'advanceInspectionTask',payload:{taskId:id}});
 await firstSeen;await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 const live=await fn({action:'readInspectionTaskStatus',payload:{taskId:id}});
 assert.equal(live.data.totalPhotos,3);
 assert.equal(live.data.completedPhotos,1,'the first photo is visible before the slowest parallel request finishes');
 releaseSlow();
 const done=await advancing;
 assert.equal(done.data.status,'success');
 assert.equal(done.data.completedPhotos,3);
});
