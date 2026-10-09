const {test}=require('node:test'),assert=require('node:assert/strict');
const {harness}=require('./cloud-harness.cjs');
function fixture(post, DateOverride=Date){const h=harness(),logs=[];h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test'},modules:{axios:{post},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},console:{log(){},warn(){},error(){},info(...args){logs.push(args)}},Date:DateOverride});return {h,fn,logs};}
function fixtureWithParallelLimit(post, limit, DateOverride=Date){const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_BATCH_PARALLEL_LIMIT:String(limit)},modules:{axios:{post},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},console:{log(){},warn(){},error(){},info(){}},Date:DateOverride});return {h,fn};}
const response=items=>({data:{choices:[{message:{content:JSON.stringify({items})}}]}});
const responseWithObservations=(items,observations)=>({data:{choices:[{message:{content:JSON.stringify({items,observations})}}]}});
function input(count=1){return {requestId:'ai-1',inputVersion:1,projectId:'p',issueDrafts:Array.from({length:count},(_,i)=>({id:'p'+i,imagePath:'cloud://env/inspection-images/user/owner/p'+i+'.png'}))};}
test('four photos with one explicit AI choice schedule and count only one photo',async()=>{
 let calls=0;const {fn}=fixture(async()=>{calls++;return responseWithObservations([{sourceIndex:0,description:'收口存在明显缺口',visualEvidence:'接缝可见空隙'}],[{sourceIndex:0,text:'可见接缝'}]);});
 const payload=input(4);payload.issueDrafts.forEach((photo,index)=>photo.analysisMode=index===0?'ai':'manual');
 const task=await fn({action:'createInspectionTask',payload});assert.equal(task.data.totalPhotos,1);
 await fn({action:'advanceInspectionTask',payload:{taskId:task.data.taskId}});
 const state=await fn({action:'readInspectionTaskStatus',payload:{taskId:task.data.taskId}});
 assert.equal(state.data.totalPhotos,1);assert.equal(state.data.completedPhotos,1);assert.equal(calls,1);
});
test('runtime status exposes capability but never credentials',async()=>{
 const {fn}=fixture(async()=>response([]));
 const result=await fn({action:'getRuntimeStatus'});
 assert.equal(result.success,true);assert.equal(result.data.visionEnabled,true);assert.equal(result.data.model,'test');
 assert.equal(result.data.batchSize,1);assert.equal(result.data.parallelLimit,3);assert.equal(result.data.maxPhotos,20);
 assert.equal(JSON.stringify(result.data).includes('isolated-test'),false);
});
test('AI parallelism cannot be raised above the product safety ceiling',async()=>{
 const {fn}=fixtureWithParallelLimit(async()=>response([]),99);
 const result=await fn({action:'getRuntimeStatus'});
 assert.equal(result.data.parallelLimit,3);
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
test('manual fallback cancels future AI batches but does not claim to stop in-flight provider calls',async()=>{
 const gates=[];let calls=0,started;
 const allStarted=new Promise(resolve=>{started=resolve;});
 const {fn}=fixtureWithParallelLimit(async()=>{
  calls++;gates.push(()=>{});
  if(calls===3)started();
  await new Promise(resolve=>{gates[calls-1]=resolve;});
  return response([]);
 },3);
 const created=await fn({action:'createInspectionTask',payload:input(5)}),id=created.data.taskId;
 const advancing=fn({action:'advanceInspectionTask',payload:{taskId:id}});
 await allStarted;
 const cancelled=await fn({action:'cancelInspectionTask',payload:{taskId:id}});
 assert.equal(cancelled.data.status,'cancelled');
 gates.slice().forEach(release=>release());
 const finished=await advancing;
 assert.equal(finished.data.status,'cancelled');
 assert.equal(finished.data.completedPhotos,0,'results from calls finishing after cancellation are not checkpointed');
 await fn({action:'advanceInspectionTask',payload:{taskId:id}});
 assert.equal(calls,3,'no later batch is sent after cancellation');
});

test('only the analysis task owner can cancel it',async()=>{
 const {h,fn}=fixture(async()=>response([]));
 const created=await fn({action:'createInspectionTask',payload:input()});
 h.as('someone-else');
 const denied=await fn({action:'cancelInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(denied.success,false);
 h.as('owner');
 assert.equal((await fn({action:'readInspectionTaskStatus',payload:{taskId:created.data.taskId}})).data.status,'queued');
});
test('cancelling an in-flight transient failure prevents its automatic paid retry',async()=>{
 let calls=0,started,rejectRequest;
 const requestStarted=new Promise(resolve=>{started=resolve;});
 const {fn}=fixture(()=>{
  calls++;started();
  return new Promise((_,reject)=>{rejectRequest=reject;});
 });
 const created=await fn({action:'createInspectionTask',payload:input()}),id=created.data.taskId;
 const advancing=fn({action:'advanceInspectionTask',payload:{taskId:id}});
 await requestStarted;
 await fn({action:'cancelInspectionTask',payload:{taskId:id}});
 const transient=Error('temporary upstream failure');transient.response={status:503};rejectRequest(transient);
 assert.equal((await advancing).data.status,'cancelled');
 assert.equal(calls,1,'the bounded automatic retry is not launched after cancellation');
});
test('vision diagnostics distinguish model-empty from model-without-evidence without logging user content',async()=>{
 const run=async candidates=>{
  const {fn,logs}=fixture(async()=>response(candidates));
  const payload=input();payload.issueDrafts[0].analysisMode='ai';payload.issueDrafts[0].voiceText='私人现场描述不应进入诊断日志';
  const created=await fn({action:'createInspectionTask',payload});
  const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
  assert.equal(done.data.status,'success');
  const entry=logs.find(args=>args[0]==='inspection_ai_candidate_counts');assert.ok(entry,'one count-only diagnostic is emitted');
  const diagnostic=JSON.parse(entry[1]);
  assert.equal(diagnostic.candidateCount,candidates.length);
  assert.equal(diagnostic.photoCount,1);
  assert.equal(diagnostic.observationCount,0);
  assert.doesNotMatch(JSON.stringify(logs),/私人现场描述|p0\.png|cloud:\/\//);
  return {diagnostic,items:done.data.analysis.items};
 };
 const empty=await run([]);
 assert.equal(empty.diagnostic.candidateCount,0);
 assert.equal(empty.diagnostic.acceptedCount,0);
 assert.equal(empty.items.length,0);

 const described=await run([{sourceIndex:0,description:'具体问题候选，但没有可见依据'}]);
 assert.equal(described.diagnostic.candidateCount,1);
 assert.equal(described.diagnostic.acceptedCount,1,'模型给了描述就不能再静默丢掉');
 assert.equal(described.diagnostic.filteredCount,0);
 assert.equal(described.items.length,1,'条目要交给人工核对，而不是消失');
});

test('a model item with no visible evidence is kept but clearly marked as unsupported',async()=>{
 const {fn}=fixture(async()=>response([{sourceIndex:0,description:'地面看起来不太干净'}]));
 const payload=input();payload.issueDrafts[0].analysisMode='ai';
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 const item=done.data.analysis.items[0];
 assert.equal(item.description,'地面看起来不太干净');
 assert.equal(item.unsupported,true,'没有可见依据必须显式标出来');
 assert.equal(item.evidenceSource,'model-only');
 assert.equal(item.confidence,'low');
 assert.equal(item.needsReview,true);
 assert.equal(item.suggestion,'','AI 仍然不得自己写处理建议');
});

test('an item grounded in the note is not marked unsupported',async()=>{
 const {fn}=fixture(async()=>response([{sourceIndex:0,description:'窗台收口有缝隙'}]));
 const payload=input();payload.issueDrafts[0].analysisMode='ai';payload.issueDrafts[0].voiceText='窗台收口不平整。';
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 const item=done.data.analysis.items[0];
 assert.equal(item.unsupported,false,'原话里有明确缺陷描述，就不算无依据');
});

test('neutral visual observations are returned per photo separately from issue candidates and survive task completion',async()=>{
 let systemPrompt='';
 const {fn,logs}=fixture(async(_url,body)=>{
  systemPrompt=body.messages.find(message=>message.role==='system')?.content||'';
  const text=JSON.stringify(body),index=text.includes('p1.png')?1:0;
  return responseWithObservations([], [{sourceIndex:0,text:index===0?'画面中可见一扇窗和相邻墙面':'画面中可见门洞及墙面'}]);
 });
 const created=await fn({action:'createInspectionTask',payload:input(2)});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');
 assert.equal(done.data.analysis.items.length,0,'observations are not problem entries');
 assert.equal(JSON.stringify(done.data.analysis.observations.map(({sourceIndex,sourcePhotoId,text})=>[sourceIndex,sourcePhotoId,text])),JSON.stringify([
  [0,'p0','画面中可见一扇窗和相邻墙面'],[1,'p1','画面中可见门洞及墙面']
 ]));
 const diagnostics=logs.filter(args=>args[0]==='inspection_ai_candidate_counts').map(args=>JSON.parse(args[1]));
 assert.deepEqual(diagnostics.map(item=>item.observationCount),[1,1]);
 assert.doesNotMatch(JSON.stringify(diagnostics),/一扇窗|门洞|可见/,'diagnostics must record counts only, never observation text');
 assert.match(systemPrompt,/observations 可返回空数组/);
 assert.match(systemPrompt,/description 只写具体位置与看到的问题，不提供处理建议/);
 assert.match(systemPrompt,/禁止泛泛写‘已识别\/未发现问题\/画面正常’/);
});
test('valid visual observations survive when a compatible model omits its empty items array',async()=>{
 const {fn}=fixture(async()=>({data:{choices:[{message:{content:JSON.stringify({observations:[{sourceIndex:0,text:'画面中可见窗边墙面与木饰面交界'}]})}}]}}));
 const created=await fn({action:'createInspectionTask',payload:input()});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');
 assert.equal(done.data.analysis.items.length,0);
 assert.equal(done.data.analysis.observations[0].text,'画面中可见窗边墙面与木饰面交界');
});
test('AI response with neither result array remains a recoverable structure failure',async()=>{
 const {fn}=fixture(async()=>({data:{choices:[{message:{content:JSON.stringify({summary:'已分析'})}}]}}));
 const created=await fn({action:'createInspectionTask',payload:input()});
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(failed.data.status,'failed');
 assert.match(failed.data.errorMessage,/返回结构不完整/);
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

test('a transient provider failure gets one bounded automatic retry for that photo',async()=>{
 let calls=0;
 const {fn}=fixture(async()=>{
  calls++;
  if(calls===1){const error=Error('temporary upstream failure');error.response={status:503};throw error;}
  return response([{sourceIndex:0,description:'收口待核对',visualEvidence:'照片可见收口缝隙',evidenceSource:'image'}]);
 });
 const created=await fn({action:'createInspectionTask',payload:input()});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');
 assert.equal(done.data.completedPhotos,1);
 assert.equal(calls,2,'one failed transient request and one automatic retry');
});

test('late transient failure skips auto-retry when the task budget cannot cover another 30s request, then remains user-resumable',async()=>{
 let now=100000,calls=0;
 class ClockDate extends Date { static now(){return now;} }
 const {fn}=fixture(async()=>{
  calls++;
  if(calls===1){now+=11000;const late=Error('temporary upstream failure');late.response={status:503};throw late;}
  return response([]);
 },ClockDate);
 const created=await fn({action:'createInspectionTask',payload:input()});
 const first=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(first.data.status,'failed');
 assert.equal(calls,1,'do not start a second 30s request with only 34s left in a 45s invocation budget');
 const resumed=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(resumed.data.status,'success','explicit resume can continue the persisted task');
 assert.equal(calls,2,'the resumed user action gets its own bounded attempt');
});

test('a transient photo gets at most one automatic retry across task resumes',async()=>{
 let calls=0;
 const {fn}=fixture(async()=>{calls++;const error=Error('upstream unavailable');error.response={status:503};throw error;});
 const created=await fn({action:'createInspectionTask',payload:input()});
 const first=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(first.data.status,'failed');assert.equal(calls,2);
 const resumed=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(resumed.data.status,'failed');assert.equal(calls,3,'resume performs one user-requested retry, without another automatic retry');
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

test('AI task progress maps filtered batch positions back to original photo numbers',async()=>{
 const {fn}=fixture(async()=>response([]));
 const payload=input(3);
 payload.issueDrafts[0].analysisMode='manual';payload.issueDrafts[0].voiceText='人工说明照片一';
 payload.issueDrafts[2].analysisMode='manual';payload.issueDrafts[2].voiceText='人工说明照片三';
 payload.issueDrafts[1].analysisMode='ai';
 const created=await fn({action:'createInspectionTask',payload});
 assert.equal(created.data.totalPhotos,1);
 assert.deepEqual(Array.from(created.data.pendingPhotoIndexes),[1]);
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');
 assert.deepEqual(Array.from(done.data.completedPhotoIndexes),[1]);
 assert.deepEqual(Array.from(done.data.pendingPhotoIndexes),[]);
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

test('AI image results inherit explicitly labelled fields from the same photo note',async()=>{
 const note='墙面收口不平整。区域：次卧窗台；责任方：木作班组（待现场确认）；处理建议：补胶后复查。';
 const {fn}=fixture(async()=>response([{
  sourceIndex:0,subIssueIndex:1,description:'墙面收口不平整',visualEvidence:'窗台收口处可见缝隙',
  evidenceSource:'image+note',confidence:'low',needsReview:true
 }]));
 const payload=input();Object.assign(payload.issueDrafts[0],{voiceText:note,analysisMode:'ai'});
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');
 const [item]=done.data.analysis.items;
 assert.equal(item.area,'次卧窗台');assert.equal(item.responsiblePartyName,'木作班组');
 assert.equal(item.suggestion,'补胶后复查');assert.equal(item.responsibleParty,'pending');
 assert.equal(item.fieldEvidence.responsiblePartyName,'责任方：木作班组（待现场确认）');
});

test('explicitly spoken issues keep labelled fields when image AI returns no supported issue',async()=>{
 const note='次卧窗台收口不平整。区域：次卧窗台；责任方：木作班组（待现场确认）。';
 const {fn}=fixture(async()=>response([]));
 const payload=input();Object.assign(payload.issueDrafts[0],{voiceText:note,analysisMode:'ai'});
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');assert.equal(done.data.analysis.items.length,1);
 const [item]=done.data.analysis.items;
 assert.equal(item.description,'次卧窗台收口不平整');
 assert.equal(item.area,'次卧窗台');assert.equal(item.responsiblePartyName,'木作班组');
 assert.equal(item.evidenceSource,'note');assert.equal(item.needsReview,true);
});

test('photo-wide labelled fields are not copied across multiple AI issues in one photo',async()=>{
 const note='问题一窗台收口不平整，问题二墙角有磕碰。区域：次卧；责任方：木作班组。';
 const {fn}=fixture(async()=>response([
  {sourceIndex:0,subIssueIndex:1,description:'窗台收口不平整',visualEvidence:'窗台处可见缝隙',evidenceSource:'image+note',confidence:'low'},
  {sourceIndex:0,subIssueIndex:2,description:'墙角有磕碰',visualEvidence:'墙角可见缺损',evidenceSource:'image+note',confidence:'low'}
 ]));
 const payload=input();Object.assign(payload.issueDrafts[0],{voiceText:note,analysisMode:'ai'});
 const created=await fn({action:'createInspectionTask',payload});
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');assert.equal(done.data.analysis.items.length,2);
 assert.equal(JSON.stringify(done.data.analysis.items.map(item=>item.area)),JSON.stringify(['','']));
 assert.equal(JSON.stringify(done.data.analysis.items.map(item=>item.responsiblePartyName||'')),JSON.stringify(['','']));
});

test('AI never turns an unresolvable photo into a successful empty result',async()=>{
 let modelCalls=0;
 const {h,fn}=fixture(async()=>{modelCalls++;return response([]);});
 // 别名/嵌套路径必须在创建阶段就被拒绝。旧 assertMedia 用 includes("/user/owner/")
 // 子串匹配，会把 archive/inspection-images/user/owner/... 判成合法归属——
 // 归属边界一旦退化成子串匹配，就等于给伪造层级留了门。
 const aliased=input();
 aliased.issueDrafts[0].imagePath='cloud://env/archive/inspection-images/user/owner/photo.png';
 aliased.issueDrafts[0].analysisMode='ai';
 const rejected=await fn({action:'createInspectionTask',payload:aliased});
 assert.equal(rejected.success,false);
 assert.match(rejected.message,/不属于当前用户/);
 assert.equal(h.table('ai_tasks').size,0,'a rejected request must not leave a task behind');

 // 通过归属校验、却不在图片目录下的引用，仍不能悄悄降级成「空结果成功」。
 const unresolvable=input();
 unresolvable.requestId='ai-2';
 unresolvable.issueDrafts[0].imagePath='cloud://env/speech-input/user/owner/voice.mp3';
 unresolvable.issueDrafts[0].analysisMode='ai';
 const created=await fn({action:'createInspectionTask',payload:unresolvable});
 assert.equal(created.success,true);
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'failed');
 assert.match(done.data.errorMessage,/照片暂时无法提供给 AI 识图/);
 assert.equal(modelCalls,0,'the model must not be called without the requested image');
 assert.deepEqual(h.calls.tempFileUrls,[]);
});

test('text organization autofills only source-grounded fields without sending any photo',async()=>{
 const note='次卧窗台收口不平整，由王工负责补胶。';
 let sent,calls=0;
 const {fn}=fixture(async(_url,body)=>{calls++;sent=body;return response([{
  sourceQuote:note,description:'次卧窗台收口不平整',area:'次卧',responsiblePartyName:'王工',suggestion:'补胶',category:'木工工程',
  evidence:{area:'次卧窗台收口不平整',responsiblePartyName:'由王工负责补胶',suggestion:'由王工负责补胶',category:'木工工程'}
 }]);});
 const payload=input();Object.assign(payload.issueDrafts[0],{voiceText:note,analysisMode:'manual',organizeText:true});
 const created=await fn({action:'createInspectionTask',payload});
 assert.equal(created.data.totalPhotos,1);
 const done=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(done.data.status,'success');assert.equal(calls,1);
 assert.doesNotMatch(JSON.stringify(sent),/image_url|cloud:\/\/|p0\.png/);
 const item=done.data.analysis.items[0];
 // 描述改为允许模型重新整理成书面表述（说/写的都是口语，能直接进报告的是书面语）；
 // 但原话必须原样留档——任何一条都能回溯到用户到底说了什么。
 assert.equal(item.description,'次卧窗台收口不平整');
 assert.equal(item.sourceQuote,note,'原话必须原样保留，重新整理不能牺牲可追溯性');assert.equal(item.area,'次卧');assert.equal(item.responsiblePartyName,'王工');
 assert.equal(item.category,'');assert.equal(item.suggestion,'','text organization must not produce remediation advice');assert.equal(item.originalText,note);
 assert.equal(item.needsReview,true);assert.equal(item.sourcePhotoId,'p0');assert.equal(item.evidenceSource,'note');
 await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});assert.equal(calls,1);
});

test('text normalization preserves uncertainty and omitted words; cannot borrow another issue responsibility',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const a='次卧疑似开裂，责任方待确认。',b='客厅胶缝缺失，由李工负责补胶。';
 const items=normalizeTextItems({id:'p',voiceText:a+b},[
  {sourceQuote:a,description:'开裂',area:'次卧',responsiblePartyName:'李工',evidence:{area:'次卧',responsiblePartyName:'由李工负责补胶'}},
  {sourceQuote:b,responsiblePartyName:'李工',evidence:{responsiblePartyName:'由李工负责补胶'}}
 ]);
 assert.equal(items[0].description,'开裂','有模型给的书面表述时采用它');
 assert.equal(items[0].sourceQuote,a,'原话原样留档');
 assert.equal(items[0].responsiblePartyName,'');assert.equal(items[1].responsiblePartyName,'李工');
 const omitted=normalizeTextItems({voiceText:a+b},[{sourceQuote:b}]);
 assert.equal(omitted.length,1);assert.equal(omitted[0].description,a+b);assert.equal(omitted[0].textExtractionFallback,true);
 const inferred=normalizeTextItems({voiceText:'木工在现场，疑似需要他负责。'},[{sourceQuote:'木工在现场，疑似需要他负责。',responsiblePartyName:'木工',evidence:{responsiblePartyName:'木工在现场，疑似需要他负责。'}}]);
 assert.equal(inferred[0].responsiblePartyName,'');
 for(const negative of ['王工不负责补胶。','补胶不由王工处理。','不是开裂，无需王工处理。']) {
  const item=normalizeTextItems({voiceText:negative},[{sourceQuote:negative,description:'开裂',responsiblePartyName:'王工',evidence:{responsiblePartyName:negative}}])[0];
  assert.equal(item.responsiblePartyName,'','否定语气下绝不猜责任方');
  assert.equal(item.sourceQuote,negative,'原话原样留档');
 }
});

test('text normalization extracts a named explicitly labelled but still unconfirmed responsibility party',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const quote='问题在墙面中部。区域：客厅墙面；责任方：木作班组（待现场确认）。';
 const [item]=normalizeTextItems({id:'p',voiceText:quote},[{
  sourceQuote:quote,
  responsiblePartyName:'木作班组',
  evidence:{responsiblePartyName:'责任方：木作班组（待现场确认）'}
 }]);
 assert.equal(item.responsiblePartyName,'木作班组');
 assert.equal(item.sourceQuote,quote,'uncertainty remains visible in the quoted source');
 const [unknown]=normalizeTextItems({voiceText:'责任方：待现场确认。'},[{
  sourceQuote:'责任方：待现场确认。',responsiblePartyName:'待现场确认',
  evidence:{responsiblePartyName:'责任方：待现场确认'}
 }]);
 assert.equal(unknown.responsiblePartyName,'','a placeholder is not a named party');
});

test('explicitly labelled note fields fill missing model fields while preserving the original quote',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const quote='墙面中部有收口问题。区域：客厅墙面；分类：木作；责任方：木作班组（待现场确认）；处理建议：补胶后复查。';
 const [item]=normalizeTextItems({id:'p',voiceText:quote},[{sourceQuote:quote}]);
 assert.equal(item.area,'客厅墙面');assert.equal(item.category,'木作');
 assert.equal(item.responsiblePartyName,'木作班组');assert.equal(item.suggestion,'','text extraction deliberately leaves treatment suggestions empty');
 assert.equal(item.description,'墙面中部有收口问题');
 assert.equal(item.sourceQuote,quote);assert.equal(item.originalText,quote);
 assert.equal(item.fieldEvidence.area,'区域：客厅墙面');
 assert.equal(item.fieldEvidence.responsiblePartyName,'责任方：木作班组（待现场确认）');
});

test('explicit field fallback rejects placeholders and negated parties',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 for(const quote of ['墙面有问题。责任方：待确认。','墙面有问题。责任方：不是木作班组。']) {
  const [item]=normalizeTextItems({voiceText:quote},[{sourceQuote:quote}]);
  assert.equal(item.responsiblePartyName,'');
 }
});

test('voice field labels without dictation punctuation are separated into readable review fields',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const quote='收口未平。区域 客厅电视背景墙；分类 木作；责任方 木作班组；处理建议 补胶后复查。';
 const [item]=normalizeTextItems({id:'voice-fields',voiceText:quote},[{sourceQuote:quote}]);
 assert.equal(item.area,'客厅电视背景墙');
 assert.equal(item.category,'木作');
 assert.equal(item.responsiblePartyName,'木作班组');
 assert.equal(item.suggestion,'');
 assert.equal(item.description,'收口未平');
 assert.equal(item.sourceQuote,quote,'the complete transcript remains available for verification');
 assert.equal(item.fieldEvidence.area,'区域 客厅电视背景墙');
});

test('text items retain source order and point IDs and never make a new number by model array order',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const p={id:'p',voiceText:'窗台收口不平整；客厅胶缝缺失',annotations:[{id:'m1',type:'point'},{id:'m2',type:'point'}]};
 const items=normalizeTextItems(p,[{sourceQuote:'客厅胶缝缺失',markerNumber:1},{sourceQuote:'窗台收口不平整',markerNumber:2},{sourceQuote:'窗台收口不平整'}]);
 assert.deepEqual(items.map(i=>[i.description,i.annotationId,i.markerNumber]),[['窗台收口不平整','m1',1],['客厅胶缝缺失','m2',2]]);
});

test('eight mixed text and photo inputs checkpoint all possible successes and retry only failures',async()=>{
 const counts=Array(8).fill(0);
 const {fn}=fixture(async(_url,body)=>{
  const s=JSON.stringify(body),i=Array.from({length:8},(_,i)=>i).find(i=>s.includes('现场编号'+i)||s.includes('p'+i+'.png'));
  counts[i]++;
  if([2,5].includes(i)&&counts[i]===1)throw Error('isolated temporary failure');
  return i%2 ? response([{sourceIndex:0,description:'缺陷'+i,visualEvidence:'照片可见缝隙',evidenceSource:'image'}]) : response([{sourceQuote:'现场编号'+i+'：窗台收口不平整。'}]);
 });
 const payload=input(8);payload.issueDrafts.forEach((p,i)=>{if(i%2===0)Object.assign(p,{voiceText:'现场编号'+i+'：窗台收口不平整。',analysisMode:'manual',organizeText:true});});
 const created=await fn({action:'createInspectionTask',payload}),taskId=created.data.taskId;
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId}});
 assert.equal(failed.data.status,'failed');assert.equal(failed.data.completedPhotos,6);assert.deepEqual(counts,Array(8).fill(1));
 const done=await fn({action:'advanceInspectionTask',payload:{taskId}});
 assert.equal(done.data.status,'success');assert.equal(done.data.analysis.items.length,8);
 assert.deepEqual(counts,[1,1,2,1,1,2,1,1]);
 assert.deepEqual(Array.from(done.data.analysis.items,i=>i.sourcePhotoId),Array.from({length:8},(_,i)=>'p'+i));
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
 const billingError=Error('Request failed with status code 402');billingError.response={status:402};let calls=0;
 const {fn}=fixture(async()=>{calls++;throw billingError;});
 const created=await fn({action:'createInspectionTask',payload:input()});
 const failed=await fn({action:'advanceInspectionTask',payload:{taskId:created.data.taskId}});
 assert.equal(failed.data.status,'failed');
 assert.match(failed.data.errorMessage,/额度暂时不足/);
 assert.doesNotMatch(failed.data.errorMessage,/402|Request failed/);
 assert.equal(calls,1,'billing failures are not automatically retried');
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
 assert.deepEqual(Array.from(live.data.completedPhotoIndexes),[0]);
 assert.deepEqual(Array.from(live.data.pendingPhotoIndexes),[1,2]);
 releaseSlow();
 const done=await advancing;
 assert.equal(done.data.status,'success');
  assert.equal(done.data.completedPhotos,3);
});

test('out-of-order parallel completion reports exact completed and pending batches',async()=>{
 const release0=[];let calls=0;
 const gates=[0,1,2].map(()=>new Promise(resolve=>release0.push(resolve)));
 const {h,fn}=fixtureWithParallelLimit(async(_url,body)=>{
   const text=JSON.stringify(body),index=[0,1,2].find(i=>text.includes('p'+i+'.png'));
   calls+=1;
   await gates[index];
   return response([{sourceIndex:0,description:'问题'+index,visualEvidence:'照片可见问题'+index,confidence:'high'}]);
 },3);
 const created=await fn({action:'createInspectionTask',payload:input(3)}),id=created.data.taskId;
 const advancing=fn({action:'advanceInspectionTask',payload:{taskId:id}});
 for(let attempt=0;attempt<20&&calls<3;attempt++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,3,'all parallel model requests must have started before releasing one out of order');
 release0[2]();
 let live;
 for(let attempt=0;attempt<20;attempt++){
  await new Promise(resolve=>setImmediate(resolve));
  live=await fn({action:'readInspectionTaskStatus',payload:{taskId:id}});
  if(live.data.completedPhotos===1)break;
 }
 assert.equal(live.data.completedPhotos,1);
 assert.deepEqual(live.data.completedBatchIndexes,[2]);
 assert.deepEqual(live.data.pendingBatchIndexes,[0,1]);
 assert.deepEqual(Array.from(live.data.completedPhotoIndexes),[2]);
 assert.deepEqual(Array.from(live.data.pendingPhotoIndexes),[0,1]);
 assert.equal(live.data.currentBatchIndex,0);
 release0[0]();release0[1]();
 const done=await advancing;
 assert.equal(done.data.status,'success');
 assert.deepEqual(done.data.completedBatchIndexes,[0,1,2]);
 assert.deepEqual(done.data.pendingBatchIndexes,[]);
 assert.equal(calls,3);
});

test('a per-account daily AI quota stops runaway spend without blocking the product',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_DAILY_LIMIT:'2'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 const draft=(id)=>({requestId:id,projectId:'p',issueDrafts:[{id:'p0',imagePath:'cloud://env/inspection-images/user/owner/p0.png'}]});
 const first=await fn({action:'createInspectionTask',payload:draft('r1')});
 const second=await fn({action:'createInspectionTask',payload:draft('r2')});
 assert.equal(first.success,true);assert.equal(second.success,true,'quota is per day, not per request');
 const third=await fn({action:'createInspectionTask',payload:draft('r3')});
 assert.equal(third.success,false,'the third task of the day must be refused');
 assert.match(third.message,/今日 AI 识别次数已达上限（2 次）/);
 assert.match(third.message,/手动填写/,'the refusal must point at the manual path that still works');
 assert.equal(h.table('ai_tasks').size,2,'a refused call must not create a task row');
});

test('yesterday\'s tasks do not count against today\'s quota',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const yesterday=Date.now()-24*60*60*1000;
 h.table('ai_tasks').set('old',{_id:'old',openId:'owner',createdAt:yesterday,requestHash:'x',status:'success'});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_DAILY_LIMIT:'1'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 const result=await fn({action:'createInspectionTask',payload:{requestId:'today',projectId:'p',issueDrafts:[{id:'p0',imagePath:'cloud://env/inspection-images/user/owner/p0.png'}]}});
 assert.equal(result.success,true,'the window is a rolling calendar day, not all-time');
});

test('a quota-count failure allows the request instead of blocking field work',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_DAILY_LIMIT:'1'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 // 让计数查询抛错：额度是成本控制，不该因一次统计异常挡住用户记录现场
 h.table('ai_tasks').count=async()=>{throw new Error('count unavailable');};
 const result=await fn({action:'createInspectionTask',payload:{requestId:'r',projectId:'p',issueDrafts:[{id:'p0',imagePath:'cloud://env/inspection-images/user/owner/p0.png'}]}});
 assert.equal(result.success,true,'fail-open: the user keeps working, the console alert is the real guard');
});

test('AI_DAILY_LIMIT=0 really means unlimited',async()=>{
 // 注释说「0 或负数表示不限制」，但旧的解析写成 `raw>0?raw:200`，
 // 于是填 0 反而得到一个 200/天的限额——与文档和下面的判断都矛盾。
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_DAILY_LIMIT:'0'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 const st=await fn({action:'getRuntimeStatus'});
 assert.equal(st.data.dailyTaskLimit,0,'填 0 必须解析成「不限制」，而不是悄悄变成 200');
 const draft=(id)=>({requestId:id,projectId:'p',issueDrafts:[{id:'p0',imagePath:'cloud://env/inspection-images/user/owner/p0.png'}]});
 for(const rid of ['a','b','c']){
   const r=await fn({action:'createInspectionTask',payload:draft(rid)});
   assert.equal(r.success,true,`不限制时第 ${rid} 次不该被拦`);
 }
});

test('a typo in AI_DAILY_LIMIT falls back to the default instead of disabling the limit',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_DAILY_LIMIT:'abc'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 const st=await fn({action:'getRuntimeStatus'});
 assert.equal(st.success,true,'配错了不能让函数起不来');
 assert.equal(st.data.dailyTaskLimit,200,'配错了要回退到默认值，而不是把限额关掉');
 const first=await fn({action:'createInspectionTask',payload:{requestId:'x',projectId:'p',issueDrafts:[{id:'p0',imagePath:'cloud://env/inspection-images/user/owner/p0.png'}]}});
 assert.equal(first.success,true,'默认值下第一条应当放行');
});

test('同步识图路径也受每日额度约束',async()=>{
 // analyzeInspection 是旧版客户端在用的同步路径。此前它既没有额度闸，
 // 也没有入参校验——直接调用可以无限次触发付费识别。
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test',AI_DAILY_LIMIT:'1'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 const photo=(i)=>({id:'p'+i,imagePath:'cloud://env/inspection-images/user/owner/p'+i+'.png'});
 const first=await fn({action:'analyzeInspection',payload:{projectId:'p',issueDrafts:[photo(0)]}});
 assert.equal(first.success,true,'第一条应当放行');
 const second=await fn({action:'analyzeInspection',payload:{projectId:'p',issueDrafts:[photo(1)]}});
 assert.equal(second.success,false,'额度用尽后同步路径也必须被拦');
 assert.match(second.message,/今日 AI 识别次数已达上限/);
});

test('同步识图路径不接受外部图片地址，也不接受超量照片',async()=>{
 const h=harness();h.table('projects').set('p',{_id:'p',ownerOpenId:'owner',deleted:false});
 const fn=h.load('ai',{env:{AI_API_KEY:'isolated-test',AI_BASE_URL:'https://not-called.invalid',AI_MODEL:'test'},
  modules:{axios:{post:async()=>response([])},'tencentcloud-sdk-nodejs':{hunyuan:{v20230901:{Client:class{}}}}},
  console:{log(){},warn(){},error(){},info(){}}});
 // resolveImageUrl 会原样放行 http(s)，等于让模型服务商去抓任意网址
 const external=await fn({action:'analyzeInspection',payload:{projectId:'p',
   issueDrafts:[{id:'x',imagePath:'https://example.com/whatever.jpg'}]}});
 assert.equal(external.success,false,'外部图片地址必须拒绝');
 assert.match(external.message,/未上传|不属于当前用户/);
 // 张数上限与异步路径保持一致
 const many=await fn({action:'analyzeInspection',payload:{projectId:'p',
   issueDrafts:Array.from({length:21},(_,i)=>({id:'p'+i,imagePath:`cloud://env/inspection-images/user/owner/p${i}.png`}))}});
 assert.equal(many.success,false);
 assert.match(many.message,/超过20张/);
});

test('用户随口说的话，AI 要能拆出区域、分类、等级',()=>{
 // 用户不会按字段说话。说「客厅那面墙裂了」时，「分类：墙面」要靠推断——
 // 值自然不可能原样出现在原话里。此前归一化要求 value 必须是原话的逐字片段，
 // 于是推断在结构上就不可能发生。
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const note='嗯就是客厅那面墙好像裂了，看着挺严重的';
 const items=normalizeTextItems({id:'p',voiceText:note},[{
   sourceQuote:note,
   description:'客厅墙面存在裂缝',
   area:'客厅', category:'墙面/油漆', severity:'major',
   evidence:{description:'客厅那面墙好像裂了',area:'客厅那面墙',category:'那面墙好像裂了',severity:'看着挺严重的'}
 }]);
 const item=items[0];
 assert.equal(item.area,'客厅','区域可以直接来自原话');
 assert.equal(item.category,'墙面/油漆','分类允许基于原话推断，不必逐字出现');
 assert.equal(item.severity,'major','用户说了「挺严重的」，等级应当据此判断');
 assert.equal(item.description,'客厅墙面存在裂缝','口语整理成能进报告的书面表述');
 assert.equal(item.sourceQuote,note,'原话原样留档');
});

test('推断可以，替人定责不行',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 // 提到工种不等于责任归属：报告是发给业主与施工方的正式文件，
 // 猜错责任方就是替人定罪。
 const cases=[
   {note:'客厅墙裂了，木工在现场、疑似需要他负责。',area:'客厅'},
   {note:'客厅墙裂了，是施工方的问题。',area:'客厅'},
   {note:'客厅墙裂了，这个应该是瓦工弄的。',area:'客厅'}
 ];
 for(const {note,area} of cases){
   const items=normalizeTextItems({id:'p',voiceText:note},[{
     sourceQuote:note, description:'客厅墙面存在裂缝', area, category:'墙面',
     responsiblePartyName:'木工',
     // 依据必须是真实原话片段——这条不能松，所以按各自的原话给
     evidence:{area, category:'墙', responsiblePartyName:note}
   }]);
   assert.equal(items[0].responsiblePartyName,'',`「${note}」不该推断出责任方`);
   assert.equal(items[0].responsibleParty,'pending');
   // 区域/分类不受影响，仍然可以基于原话推断
   assert.equal(items[0].area,area);
   assert.equal(items[0].category,'墙面','分类可以推断，不必逐字出现在原话里');
 }
});

test('等级只接受系统认的三档，没有程度线索就给一般',()=>{
 const {normalizeTextItems}=require('../cloudfunctions/ai/text-organizer');
 const note='墙角有点脏';
 const build=(severity,evidence)=>({sourceQuote:note,description:'墙角存在污染',severity,
   evidence:{severity:evidence}});
 for(const bad of ['serious','高','',undefined]){
   const items=normalizeTextItems({id:'p',voiceText:note},[build(bad,'有点脏')]);
   assert.equal(items[0].severity,'normal',`非法等级 ${bad} 必须回落到 normal`);
 }
 // 有依据才采纳推断出的等级
 const noEvidence=normalizeTextItems({id:'p',voiceText:note},[{sourceQuote:note,severity:'critical',evidence:{}}]);
 assert.equal(noEvidence[0].severity,'normal','没有原话依据的等级不予采纳');
});
