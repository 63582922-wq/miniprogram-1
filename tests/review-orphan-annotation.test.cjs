const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadPage}=require('./page-harness.cjs');

/**
 * 核对页在生成报告前必须拦住「照片上有编号标注、却一条问题都没有」的情况。
 *
 * 报告里的编号是从问题条目推出来的（group.markers = issues.filter(...)），
 * 没有对应问题，标注号就会整个从报告里消失——照片还在，但编号和说明
 * 都没有了。真机实测中这正是「我明明标了位置 1，报告里什么都没有」的来源。
 */

const stub={
  '../../../services/inspection':{confirmInspection:async()=>({inspectionId:'i'})},
  '../../../services/report':{buildReportData:async()=>({}),saveReport:async()=>({_id:'r'})},
  '../../../services/inspection-media':{uploadDraftMedia:async form=>form},
  '../../../utils/router':{encodeReturnContext:()=>'',returnToContext:()=>{}},
  '../../../utils/guide':{markGuideStep:()=>{}},
  '../../../services/settings':{getSettings:async()=>({})},
  '../../../services/user':{getCurrentUser:async()=>({})},
  '../../../services/cloud-media':{resolveCloudFileUrls:async()=>({urls:{},failed:[]}),isCloudFileId:()=>false}
};

function mount(issueDrafts,analysisItems){
  const calls={modals:[],submitted:0};
  const draft={sessionId:'s',form:{projectId:'p',projectName:'项目',issueDrafts},analysis:{aiMode:'model',items:analysisItems||[],observations:[]}};
  const {page}=loadPage('inspection/result',{
    ...stub,
    '../../../utils/inspection-draft':{
      readDraft:()=>draft,
      writeDraft:()=>{},
      patchDraft:()=>{},
      finishDraft:()=>{}
    }
  },{
    showModal:options=>calls.modals.push(options),
    showToast:()=>{},
    showLoading:()=>{},
    hideLoading:()=>{},
    vibrateShort:()=>{}
  });
  page.onLoad({sessionKey:'s'});
  page.submitReviewedIssues=()=>{calls.submitted++;};
  return {page,calls};
}

const marker=id=>({id,type:'point'});

test('a photo with a marker but no issue blocks publication and says which photo',async()=>{
  const {page,calls}=mount([
    {id:'photo-A',imagePath:'/a.jpg',annotations:[marker('m1')]},
    {id:'photo-B',imagePath:'/b.jpg',annotations:[marker('m2')]}
  ],[
    {sourcePhotoId:'photo-A',description:'A 有问题'}
  ]);
  await page.handleSubmit();
  assert.equal(calls.submitted,0,'不能直接发布');
  const modal=calls.modals.at(-1);
  assert.equal(modal.title,'有标注没有对应问题');
  assert.match(modal.content,/照片 2/,'要点名是哪张照片');
  assert.doesNotMatch(modal.content,/照片 1/,'已经写了问题的照片不该被点名');
  assert.match(modal.content,/补充问题说明|移除标注/,'要给出可执行的下一步');
});

test('a photo whose marker already has an issue passes straight through',async()=>{
  const {page,calls}=mount([
    {id:'photo-A',imagePath:'/a.jpg',annotations:[marker('m1')]}
  ],[
    {sourcePhotoId:'photo-A',description:'A 有问题'}
  ]);
  await page.handleSubmit();
  assert.equal(calls.submitted,1);
  assert.equal(calls.modals.length,0);
});

test('a photo with no marker at all is not treated as orphaned',async()=>{
  const {page,calls}=mount([
    {id:'photo-A',imagePath:'/a.jpg',annotations:[]}
  ],[]);
  await page.handleSubmit();
  assert.equal(calls.submitted,1,'零标注零问题的照片本来就合法');
});

test('only numbered shapes count as markers',async()=>{
  // 未编号的矩形只是画着玩，不构成「标注 1」，不该拦住发布。
  const {page,calls}=mount([
    {id:'photo-A',imagePath:'/a.jpg',annotations:[{id:'x',type:'box',numbered:false}]}
  ],[]);
  await page.handleSubmit();
  assert.equal(calls.submitted,1);
});

test('removing a blank issue still leaves the marker uncovered, and that is caught too',async()=>{
  // 「有标注 + 一条空白问题」会先走空白行确认分支；移除之后必须再过一次
  // 标注核对，否则就从那个分支直接发布出去了。
  const {page,calls}=mount([
    {id:'photo-A',imagePath:'/a.jpg',annotations:[marker('m1')]}
  ],[
    {sourcePhotoId:'photo-A',description:'   '}
  ]);
  await page.handleSubmit();
  assert.equal(calls.submitted,0);
  const blankModal=calls.modals.at(-1);
  assert.equal(blankModal.title,'移除空白问题？');

  blankModal.success({confirm:true});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.submitted,0,'移除空白行后标注仍未覆盖，不能发布');
  assert.equal(calls.modals.at(-1).title,'有标注没有对应问题');
});
