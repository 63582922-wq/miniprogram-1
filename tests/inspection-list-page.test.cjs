const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadPage,deferred}=require('./page-harness.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function mount({list,remove}={}){
  const calls={listed:[],deleted:[],toasts:[],sheets:0,navigated:[]};
  const {page}=loadPage('inspection/list',{
    '../../../services/inspection':{
      listInspections:async params=>{
        calls.listed.push(params);
        return list?list(params,calls.listed.length):{list:[],page:1,hasMore:false};
      },
      deleteInspection:async id=>{calls.deleted.push(id);return remove?remove(id):{success:true};}
    },
    '../../../utils/record-entry':{openRecord:async()=>{}}
  },{
    vibrateShort:()=>{},
    showActionSheet:options=>{calls.sheets++;calls.sheetOptions=options;},
    showModal:options=>{calls.modalOptions=options;},
    showToast:options=>calls.toasts.push(options),
    navigateTo:options=>calls.navigated.push(options),
    getStorageSync:()=>'',setStorageSync:()=>{},removeStorageSync:()=>{}
  });
  return {page,calls};
}

test('a slow earlier list response cannot replace a newer one',async()=>{
  const stale=deferred(),fresh=deferred();
  let call=0;
  const {page}=mount({list:()=>{call++;return call===1?stale.promise:fresh.promise;}});
  page.onShow();
  page.loadInspections();

  fresh.resolve({list:[{_id:'new',createdAt:1}],page:1,hasMore:false});
  await flush();
  assert.deepEqual(page.data.inspectionList.map(row=>row._id),['new']);

  stale.resolve({list:[{_id:'old',createdAt:1}],page:1,hasMore:false});
  await flush();
  assert.deepEqual(page.data.inspectionList.map(row=>row._id),['new'],'过期响应不得把旧列表打回屏幕');
});

test('a stale response cannot switch off the loading state of a newer request',async()=>{
  const stale=deferred(),fresh=deferred();
  let call=0;
  const {page}=mount({list:()=>{call++;return call===1?stale.promise:fresh.promise;}});
  page.onShow();
  page.loadInspections();
  assert.equal(page.data.loading,true);

  stale.resolve({list:[{_id:'old',createdAt:1}],page:1,hasMore:false});
  await flush();
  assert.equal(page.data.loading,true,'新请求仍在进行时不能被旧请求的 finally 关掉加载态');
  assert.deepEqual(page.data.inspectionList,[],'旧结果也不该上屏');

  fresh.resolve({list:[{_id:'new',createdAt:1}],page:1,hasMore:false});
  await flush();
  assert.equal(page.data.loading,false);
  assert.deepEqual(page.data.inspectionList.map(row=>row._id),['new']);
});

test('a stale failure cannot overwrite the error text of a newer request',async()=>{
  const stale=deferred(),fresh=deferred();
  let call=0;
  const {page}=mount({list:()=>{call++;return call===1?stale.promise:fresh.promise;}});
  page.onShow();
  page.loadInspections();

  stale.reject(new Error('旧的网络错误'));
  await flush();
  assert.equal(page.data.loadError,'','旧请求的错误不能显示给用户');

  fresh.reject(new Error('新的网络错误'));
  await flush();
  assert.equal(page.data.loadError,'新的网络错误');
});

test('rows carry a formatted time and a project fallback',async()=>{
  const {page}=mount({list:()=>({list:[{_id:'a',createdAt:Date.UTC(2026,9,1,3,4)}],page:1,hasMore:false})});
  await page.loadInspections();
  assert.ok(page.data.inspectionList[0].createdAtText.length>0);
  assert.equal(page.data.inspectionList[0].projectNameText,'未关联项目');
});

test('loading more only happens when there is more, and never twice at once',async()=>{
  const {page,calls}=mount({list:()=>({list:[{_id:'a',createdAt:1}],page:1,hasMore:false})});
  await page.loadInspections();
  assert.equal(page.data.hasMore,false);
  page.onReachBottom();
  assert.equal(calls.listed.length,1,'没有更多时不应再请求');

  const gate=deferred();
  const {page:second,calls:secondCalls}=mount({list:()=>gate.promise});
  second.data.hasMore=true;
  const pending=second.loadInspections(true);
  second.onReachBottom();
  assert.equal(secondCalls.listed.length,1,'追加加载进行中不得重复触发');
  assert.equal(secondCalls.listed[0].page,1,'首次追加应请求第 2 页（page 从 0 起算 +1）');

  gate.resolve({list:[{_id:'b',createdAt:1}],page:2,hasMore:true});
  await pending;
  assert.deepEqual(second.data.inspectionList.map(row=>row._id),['b']);
});

test('long press without an id does nothing',async()=>{
  const {page,calls}=mount();
  await page.handleInspectionLongPress({currentTarget:{dataset:{}}});
  assert.equal(calls.sheets,0,'缺少记录编号时不应弹出操作面板');
  assert.equal(calls.deleted.length,0);
});

test('cancelling the sheet or the confirmation never deletes the record',async()=>{
  const {page,calls}=mount();

  // 面板被取消：showActionSheet 的 fail 分支带着 cancel 文案
  const cancelled=page.handleInspectionLongPress({currentTarget:{dataset:{inspectionId:'i1',inspectionTitle:'记录'}}});
  calls.sheetOptions.fail({errMsg:'showActionSheet:fail cancel'});
  await cancelled;
  assert.equal(calls.deleted.length,0);
  assert.equal(calls.toasts.length,0,'主动取消不该弹失败提示');
  assert.equal(calls.modalOptions,undefined);

  // 二次确认里点取消
  const declined=page.handleInspectionLongPress({currentTarget:{dataset:{inspectionId:'i1',inspectionTitle:'记录'}}});
  calls.sheetOptions.success({tapIndex:0});
  await flush();
  calls.modalOptions.success({confirm:false});
  await declined;
  assert.equal(calls.deleted.length,0,'未确认时不得删除');
});

test('confirming deletes the record and refreshes the list',async()=>{
  const {page,calls}=mount({list:()=>({list:[{_id:'i2',createdAt:2}],page:1,hasMore:false})});
  const pending=page.handleInspectionLongPress({currentTarget:{dataset:{inspectionId:'i1',inspectionTitle:'记录'}}});
  await flush();
  calls.sheetOptions.success({tapIndex:0});
  await flush();
  calls.modalOptions.success({confirm:true});
  await pending;

  assert.deepEqual(calls.deleted,['i1']);
  assert.equal(calls.toasts.at(-1).title,'已删除');
  assert.ok(calls.listed.length>=1,'删除后必须刷新列表');
});

test('a failed delete reports the reason instead of pretending success',async()=>{
  const {page,calls}=mount({remove:()=>{throw new Error('记录已被删除');}});
  const pending=page.handleInspectionLongPress({currentTarget:{dataset:{inspectionId:'i1',inspectionTitle:'记录'}}});
  await flush();
  calls.sheetOptions.success({tapIndex:0});
  await flush();
  calls.modalOptions.success({confirm:true});
  await pending;

  assert.equal(calls.toasts.at(-1).title,'记录已被删除');
  assert.notEqual(calls.toasts.at(-1).title,'已删除');
});

test('opening a record only carries a return context when a project is known',async()=>{
  const {page,calls}=mount();
  page.setData({projectId:'',projectName:''});
  page.openDetail({currentTarget:{dataset:{inspectionId:'i1'}}});
  assert.equal(calls.navigated.at(-1).url,'/pages/inspection/detail/index?inspectionId=i1');

  page.setData({projectId:'p1',projectName:'项目甲'});
  page.openDetail({currentTarget:{dataset:{inspectionId:'i1'}}});
  assert.match(calls.navigated.at(-1).url,/returnContext=/,'有项目上下文时要能回到该项目');
});
