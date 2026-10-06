const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadPage}=require('./page-harness.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function mount({listRequests,submitRequest}={}){
  const calls={submitted:[],listed:0};
  const {page}=loadPage('legal',{
    '../../services/user':{
      listPrivacyRequests:async()=>{calls.listed++;return (listRequests||(async()=>[]))();},
      submitPrivacyRequest:async payload=>{
        calls.submitted.push(payload);
        return submitRequest?submitRequest(payload,calls.submitted.length):{success:true};
      }
    }
  },{navigateBack(){calls.navigatedBack=(calls.navigatedBack||0)+1;}});
  return {page,calls};
}

test('privacy requests are shown in human terms, including an unknown server status',async()=>{
  const {page}=mount({listRequests:async()=>([
    {_id:'a',requestType:'注销账号',status:'received',createdAt:Date.UTC(2026,9,1)},
    {_id:'b',requestType:'更正',status:'processing',createdAt:Date.UTC(2026,9,2)},
    {_id:'c',requestType:'删除个人信息',status:'completed',createdAt:Date.UTC(2026,9,3)},
    {_id:'d',requestType:'其他',status:'rejected',createdAt:Date.UTC(2026,9,4)},
    {_id:'e',requestType:'撤回同意',status:'brand-new-status',createdAt:Date.UTC(2026,9,5)}
  ])});
  page.onShow();
  await flush();

  assert.deepEqual(page.data.requests.map(row=>row.statusText),[
    '已受理，待核验','处理中','已处理','无法按申请处理','待运营者确认'
  ]);
  assert.ok(page.data.requests[0].dateText.length>0,'申请日期要能被用户看见');
});

test('a failed status read never blocks reading the privacy statement',async()=>{
  const {page}=mount({listRequests:async()=>{throw new Error('collection not exists');}});
  page.onShow();
  await flush();
  assert.deepEqual(page.data.requests,[],'读不到申请列表时保持空列表，不抛错、不误导');
});

test('a double tap submits one request, and the receipt never claims it is done',async()=>{
  const {page,calls}=mount();
  page.handleRequestTypeChange({detail:{value:'3'}});
  page.handleRequestDetailsInput({detail:{value:'请删除我的资料'}});

  const first=page.submitRequest();
  const second=page.submitRequest();
  await Promise.all([first,second]);

  assert.equal(calls.submitted.length,1,'连续点击只能产生一次申请');
  assert.equal(calls.submitted[0].requestType,'注销账号');
  assert.equal(calls.submitted[0].details,'请删除我的资料');
  assert.match(page.data.requestMessage,/尚未完成处理/,'收件回执不能写成已完成');
  assert.equal(page.data.submitting,false,'提交结束后必须解除禁用态');
});

test('retrying after a failure reuses the same request id so the server can deduplicate',async()=>{
  let attempt=0;
  const {page,calls}=mount({submitRequest:()=>{
    attempt++;
    if(attempt===1)throw new Error('网络异常');
    return {success:true};
  }});

  await page.submitRequest();
  assert.match(page.data.requestMessage,/没有提交成功/);
  assert.equal(page.data.submitting,false);
  await page.submitRequest();

  assert.equal(calls.submitted.length,2);
  assert.equal(calls.submitted[0].requestId,calls.submitted[1].requestId,'重试必须复用同一申请编号');
  assert.ok(calls.submitted[0].requestId.length>=12);
});

test('a raw cloud error is never shown to the user',async()=>{
  // 实测：集合缺失时云返回 -502005 的英文长串 + 文档链接。
  // 这种内容甩在合规功能上既看不懂也不知道该做什么。
  const raw='[auth:submitPrivacyRequest] collection.add:fail -502005 database collection not exists. '
    +'[ResourceNotFound] Db or Table not exist: privacy_requests. Please check your request, '
    +'but if the problem cannot be solved, contact us. 更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/DATABASE_COLLECTION_NOT_EXIST';
  const {page}=mount({submitRequest:()=>{throw new Error(raw);}});
  await page.submitRequest();
  const shown=page.data.requestMessage;
  assert.doesNotMatch(shown,/502005|ResourceNotFound|cloudbase|collection\.add/,'原始云错误不得出现在页面上');
  assert.match(shown,/没有提交成功/);
  assert.match(shown,/重试|联系我们/,'要给出可执行的下一步');
});

test('a failed status read says so instead of looking like no requests exist',async()=>{
  const {page}=mount({listRequests:async()=>{throw new Error('collection not exists');}});
  page.onShow();
  await flush();
  assert.deepEqual(page.data.requests,[]);
  assert.equal(page.data.requestsLoaded,false,'读失败必须与「确实没有申请」区分开');
});
