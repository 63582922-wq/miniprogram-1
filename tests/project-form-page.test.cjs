const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadPage,memoryStorage}=require('./page-harness.cjs');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function mount({draft,detail,save}={}){
  const calls={saved:[],toasts:[],modals:[],redirects:[],guide:[]};
  const storage=memoryStorage(draft?{'projectCreateDraftV2:owner':draft}:{});
  const {page}=loadPage('project/form',{
    '../../../services/project':{
      getProjectDetail:async id=>({project:{_id:id,name:'既有项目',address:'测试路 1 号',status:'active'}}),
      saveProject:async payload=>{calls.saved.push(payload);return save?save(payload,calls.saved.length):{_id:'proj-1'};}
    },
    '../../../utils/guide':{markGuideStep:(step,value)=>{calls.guide.push([step,value]);}}
  },{
    ...storage.api,
    showToast:options=>calls.toasts.push(options),
    showModal:options=>calls.modals.push(options),
    redirectTo:options=>calls.redirects.push(options)
  },{
    getApp:()=>({ensureReady:async()=>{},globalData:{userInfo:{openId:'owner'}}})
  });
  return {page,calls,storage};
}

test('an empty project name is refused before any cloud call',async()=>{
  const {page,calls}=mount();
  await page.onLoad({});
  page.data.form.name='   ';
  await page.handleSubmit();

  assert.equal(calls.saved.length,0,'空名称不得发出保存请求');
  assert.equal(calls.toasts[0].title,'请填写项目名称');
  assert.equal(calls.redirects.length,0);
});

test('a successful create clears the local draft, marks the guide step and opens the saved project',async()=>{
  const {page,calls,storage}=mount();
  await page.onLoad({});
  page.handleInput({currentTarget:{dataset:{field:'name'}},detail:{value:'新项目'}});
  assert.ok(storage.store.has('projectCreateDraftV2:owner'),'输入后本地应留有草稿');

  await page.handleSubmit();

  assert.equal(calls.saved.length,1);
  assert.equal(calls.saved[0].name,'新项目');
  assert.equal(calls.saved[0].projectId,'','新建时不应带项目编号');
  assert.equal(storage.store.has('projectCreateDraftV2:owner'),false,'确认保存成功后才清草稿');
  assert.deepEqual(calls.guide,[['projectCreated',true]]);
  assert.equal(calls.redirects.length,1);
  assert.match(calls.redirects[0].url,/projectId=proj-1/);
});

test('a create response without a project id keeps the draft and does not navigate',async()=>{
  const {page,calls,storage}=mount({save:()=>({})});
  await page.onLoad({});
  page.handleInput({currentTarget:{dataset:{field:'name'}},detail:{value:'新项目'}});
  await page.handleSubmit();

  assert.equal(calls.redirects.length,0);
  assert.equal(calls.modals.length,1);
  assert.match(calls.modals[0].content,/不会重复创建/);
  assert.ok(storage.store.has('projectCreateDraftV2:owner'),'未确认成功时草稿必须保留');
});

test('an edit that comes back with a different project id is treated as a failed save',async()=>{
  const {page,calls}=mount({save:()=>({_id:'someone-else'})});
  await page.onLoad({projectId:'proj-1'});
  assert.equal(page.data.form.name,'既有项目');
  await page.handleSubmit();

  assert.equal(calls.saved.length,1);
  assert.equal(calls.redirects.length,0,'编号对不上时不能跳转到错误项目');
  assert.match(calls.modals[0].content,/可确认的项目编号/);
});

test('a second tap while saving cannot create a duplicate project',async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const {page,calls}=mount({save:async()=>{await gate;return {_id:'proj-1'};}});
  await page.onLoad({});
  page.handleInput({currentTarget:{dataset:{field:'name'}},detail:{value:'新项目'}});

  const first=page.handleSubmit();
  await flush();
  await page.handleSubmit();
  release();
  await first;

  assert.equal(calls.saved.length,1,'保存中重复点击只能发出一次');
});

test('a failed load blocks saving instead of writing an empty project over it',async()=>{
  const {page,calls}=mount();
  await page.onLoad({projectId:'proj-1'});
  page.loadFailed=true;
  page.data.form.name='既有项目';
  await page.handleSubmit();
  assert.equal(calls.saved.length,0,'加载失败时不得提交');
});

test('inputs are ignored for unknown fields and after submission is locked',async()=>{
  const {page}=mount();
  await page.onLoad({});
  page.handleInput({currentTarget:{dataset:{field:'role'}},detail:{value:'admin'}});
  assert.equal(page.data.form.role,undefined,'白名单之外的字段不得写入表单');

  page.data.submissionLocked=true;
  page.handleInput({currentTarget:{dataset:{field:'name'}},detail:{value:'改不了'}});
  assert.equal(page.data.form.name,'','锁定后不得再改表单');
});
