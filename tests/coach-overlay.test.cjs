const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');
const exists=(p)=>fs.existsSync(path.join(root,p));

/**
 * 高亮引导此前是「设计好了但没实现」：utils/coach.js 有完整状态机，
 * 设置页算了 coachTipVisible/coachHighlightSave，但全项目的 WXML/WXSS 里
 * 搜不到任何渲染它的东西——没有任何遮罩、没有高亮、没有箭头。
 * startCoach("projectCreateForm") 启动了第二步，而新建项目页从没读过它。
 *
 * 这一组测试锁住：遮罩真的存在、每一步都真的接了线、以及洞不挡点击。
 */

const PAGES = {
  settingsSave: 'miniprogram/pages/settings/index',
  projectCreateForm: 'miniprogram/pages/project/form/index',
  projectDetailStart: 'miniprogram/pages/project/detail/index',
  capturePickPhoto: 'miniprogram/pages/inspection/create/index',
  captureAnnotate: 'miniprogram/pages/inspection/create/index',
  captureVoice: 'miniprogram/pages/inspection/create/index',
  captureContinue: 'miniprogram/pages/inspection/create/index',
  reviewPublish: 'miniprogram/pages/inspection/result/index',
  reportShare: 'miniprogram/pages/report/detail/index'
};

const coachSteps=()=>{
  const module={exports:{}};
  vm.runInNewContext(read('miniprogram/utils/coach.js'),{
    module,require:()=>({}),
    wx:{getStorageSync:()=>({}),setStorageSync:()=>{}}
  });
  return module.exports.COACH_STEPS;
};

test('every coach step is wired into a real page',()=>{
  const steps=coachSteps();
  assert.ok(steps.length>=8,`引导步骤应覆盖完整流程，实际 ${steps.length} 步`);
  for(const step of steps){
    const page=PAGES[step];
    assert.ok(page,`步骤 ${step} 没有对应的页面——加了步骤却忘了接线`);
    assert.ok(exists(page+'.js'),`${page}.js 不存在`);
    const source=read(page+'.js');
    assert.match(source,new RegExp(`["']${step}["']`),
      `${page} 没有引用步骤 ${step}`);
    assert.match(source,/syncCoach\(\)/,
      `${page} 没有调用 syncCoach()——步骤启动了却没人渲染`);
  }
});

test('every wired page mounts the overlay and declares its coach state',()=>{
  for(const page of new Set(Object.values(PAGES))){
    const json=JSON.parse(read(page+'.json'));
    assert.ok(json.usingComponents&&json.usingComponents['coach-overlay'],
      `${page}.json 没有注册 coach-overlay`);
    assert.match(read(page+'.wxml'),/<coach-overlay[\s\S]{0,400}bind:next="handleCoachNext"[\s\S]{0,200}bind:skip="handleCoachSkip"/,
      `${page}.wxml 没有挂载遮罩或没接事件`);
    const source=read(page+'.js');
    assert.match(source,/coachData\(\)/,
      `${page} 没有把 coachData() 展开进 data——遮罩拿不到位置与文案`);
    assert.match(source,/coachMethods(Multi)?\(/,
      `${page} 没有接入 coachMethods`);
  }
});

test('the highlight never blocks the button it points at',()=>{
  const markup=read('miniprogram/components/coach-overlay/index.wxml');
  const style=read('miniprogram/components/coach-overlay/index.wxss');
  // 洞的位置不渲染任何元素，点击才能落到被高亮的真实按钮上
  assert.doesNotMatch(markup,/coach__hole/,'洞不应有独立元素——那会挡住目标按钮');
  assert.match(markup,/coach__mask/,'遮罩应由四块面板围成');
  assert.match(style,/\.coach\s*\{[\s\S]*?width:\s*0;[\s\S]*?height:\s*0;/,
    '容器必须是 0×0 的锚点，否则整页都点不动');
  assert.match(style,/\.coach__ring\s*\{[\s\S]*?pointer-events:\s*none;/,
    '高亮框不能拦截点击');
});

test('a missing wx runtime never crashes a page that only wants to show a tip',()=>{
  // 页面测试在隔离 vm 里跑，注入的 wx 到不了被 require 的模块。
  // 直接 wx.getStorageSync 会抛 ReferenceError，把整页测试带崩。
  const module={exports:{}};
  vm.runInNewContext(read('miniprogram/utils/coach.js'),{module,require:()=>({})});
  assert.doesNotThrow(()=>module.exports.getCoachState(),'没有 wx 时也要能安全读取');
  assert.equal(module.exports.getCoachState().active,false,'读不到状态就当没有引导');
  assert.doesNotThrow(()=>module.exports.startCoach('settingsSave'),'没有 wx 时写入不能抛错');
  assert.doesNotThrow(()=>module.exports.stopCoach());
});

test('guidance advances because the user did the thing, not because they tapped next',()=>{
  const helper=read('miniprogram/utils/coach-page.js');
  // 气泡上只有「跳过引导」和「知道了」；推进靠页面在动作成功后调 advanceCoach
  assert.match(helper,/handleCoachNext\(\)\s*\{[\s\S]{0,200}coachVisible:\s*false/,
    '「知道了」只收起气泡，不应推进步骤');
  assert.match(helper,/advanceCoach\(/,'页面必须能主动推进');
  const component=read('miniprogram/components/coach-overlay/index.wxml');
  assert.match(component,/跳过引导/);
  assert.match(component,/知道了/);
  assert.doesNotMatch(component,/下一步/,'给「下一步」会把用户从真实操作上引开');
});

test('the capture page lights up its four steps in field order',()=>{
  const source=read('miniprogram/pages/inspection/create/index.js');
  const block=source.slice(source.indexOf('coachMethodsMulti(['),source.indexOf(']),',source.indexOf('coachMethodsMulti([')));
  const order=['capturePickPhoto','captureAnnotate','captureVoice','captureContinue'];
  let cursor=-1;
  for(const step of order){
    const at=block.indexOf(step);
    assert.ok(at>0,`采集页缺少步骤 ${step}`);
    assert.ok(at>cursor,`${step} 的顺序不对——应按现场实际顺序`);
    cursor=at;
  }
  // 后三步的目标元素要等到有照片才存在
  assert.match(block,/ready\(\)/,'按状态出现的步骤必须有 ready 判断，否则会指着空气');
});
