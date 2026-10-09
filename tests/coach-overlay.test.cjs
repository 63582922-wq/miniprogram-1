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
  // 必须先剥掉 WXML 注释再判断：说明性注释里很容易出现「下一步」这种词，
  // 直接搜全文会把注释当成按钮文案（这个坑已经踩过第二次了）。
  const component=read('miniprogram/components/coach-overlay/index.wxml')
    .replace(/<!--[\s\S]*?-->/g,'');
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

test('every highlighted selector actually exists in that page markup',()=>{
  // 这条是补的：曾经 coach-voice 的 id 在调整属性顺序时丢了，
  // 于是第 6 步永远指不到元素。而当时的测试只检查「步骤名出现在 JS 里」，
  // 没检查「选择器在 WXML 里真有对应元素」，所以没能拦住。
  for(const page of new Set(Object.values(PAGES))){
    const script=read(page+'.js');
    const markup=read(page+'.wxml');
    const selectors=[...script.matchAll(/selector:\s*"#([a-zA-Z0-9_-]+)"/g)].map(m=>m[1]);
    for(const selector of new Set(selectors)){
      assert.ok(markup.includes(selector),
        `${page}.wxml 里没有 id="${selector}"——这一步会永远指不到东西`);
    }
    // 单步版用字符串字面量传选择器，一并检查
    const literal=[...script.matchAll(/coachMethods\(\s*"[^"]+"\s*,\s*"#([a-zA-Z0-9_-]+)"/g)].map(m=>m[1]);
    for(const selector of new Set(literal)){
      assert.ok(markup.includes(selector),
        `${page}.wxml 里没有 id="${selector}"——这一步会永远指不到东西`);
    }
  }
});

test('the tip uses one full-width button, matching the app\'s own sheet pattern',()=>{
  const style=read('miniprogram/components/coach-overlay/index.wxss');
  const markup=read('miniprogram/components/coach-overlay/index.wxml');
  // 曾经把「跳过引导」和「知道了」并排，一大一小、不在同一基线，视觉很乱
  assert.doesNotMatch(style,/\.coach__actions/,'不该再有并排按钮的容器');
  assert.match(style,/\.coach__next\s*\{[\s\S]{0,200}width:\s*100%\s*!important/,
    '主按钮要通栏');
  assert.match(style,/\.coach__skip\s*\{[\s\S]{0,200}background:\s*transparent/,
    '「跳过引导」要退成一行小字，不能和主按钮抢');
  assert.ok(markup.indexOf('coach__next')<markup.indexOf('coach__skip'),
    '主按钮在上、次动作在下');
});

test('the highlight ring hugs a button, not a container',()=>{
  // 框套在 footer 容器上会连底部安全区一起框住，而且圆角和按钮的胶囊边打架
  for(const page of new Set(Object.values(PAGES))){
    const markup=read(page+'.wxml');
    for(const m of markup.matchAll(/<([a-z-]+)([^>]{0,300}?)id="(coach-[a-zA-Z0-9_-]+)"/g)){
      assert.equal(m[1],'button',
        `${page}.wxml 的 #${m[3]} 挂在 <${m[1]}> 上；高亮目标应当是按钮本身`);
    }
  }
});

test('a step whose target is not there yet still says what to do',()=>{
  const helper=read('miniprogram/utils/coach-page.js');
  const component=read('miniprogram/components/coach-overlay/index.wxml');
  assert.match(helper,/pendingText/,'目标缺失时要有交代，不能什么都不显示');
  assert.match(component,/coach__tip--centered/,'无目标时气泡居中');
  const capture=read('miniprogram/pages/inspection/create/index.js');
  const pending=(capture.match(/pendingText:/g)||[]).length;
  assert.ok(pending>=3,`采集页后三步都要有 pendingText，实际 ${pending} 处`);
});

test('every binding the overlay template uses is actually declared',()=>{
  // 曾经 pendingText 只写进了 WXML 与页面数据，组件却没声明这个属性，
  // 于是那行「先拍一张照片…」永远不显示，而且不报错。
  const script=read('miniprogram/components/coach-overlay/index.js');
  const markup=read('miniprogram/components/coach-overlay/index.wxml')
    .replace(/<!--[\s\S]*?-->/g,'');
  const propsBlock=script.slice(script.indexOf('properties: {'),script.indexOf('data: {'));
  const dataBlock=script.slice(script.indexOf('data: {'),script.indexOf('observers: {'));
  const declared=new Set([
    ...[...propsBlock.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m=>m[1]),
    ...[...dataBlock.matchAll(/^\s{4}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(m=>m[1])
  ]);
  const used=new Set([...markup.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)/g)].map(m=>m[1]));
  for(const name of used){
    assert.ok(declared.has(name),
      `模板用了 {{${name}}}，但组件既没声明这个属性也没有这个 data 字段——它会静默失效`);
  }
});

test('the tip text is centred, not left-aligned',()=>{
  // 说明文字横跨整个气泡宽度，左对齐会偏在一边，与下面通栏的主按钮也不在同一中轴。
  const style=read('miniprogram/components/coach-overlay/index.wxss');
  const rule=style.match(/\.coach__step,\s*\.coach__title,\s*\.coach__desc,\s*\.coach__pending\s*\{([^}]*)\}/s);
  assert.ok(rule,'气泡内文字应有一处统一的居中声明');
  assert.match(rule[1],/text-align:\s*center/,'说明文字必须居中，不能左对齐');
});

test('the guide never writes to a page the user already left',()=>{
  // syncCoach 最长等约 7 秒；用户完全可能在这期间返回。
  // 直接 setData 会打到已卸载的页面上——项目里其它异步都用 generation 计数防这类竞态。
  const helper=read('miniprogram/utils/coach-page.js');
  assert.match(helper,/function isPageAlive/,'必须有存活性判断');
  assert.match(helper,/getCurrentPages\(\)\.indexOf\(page\)\s*>=\s*0/,'用「还在不在页面栈里」判断');
  assert.match(helper,/function setCoachData/,'setData 要走统一的守卫');
  // 辅助方法里不允许再出现裸的 this.setData
  const body=helper.slice(helper.indexOf('function coachMethods('));
  assert.doesNotMatch(body,/this\.setData\(/,'引导写入必须全部经过 setCoachData');
});

test('the capture page clears its delayed coach retry on unload',()=>{
  const page=read('miniprogram/pages/inspection/create/index.js');
  assert.match(page,/this\.coachRetryTimer = setTimeout\(/,'延迟重试要留下句柄');
  const unload=page.slice(page.indexOf('onUnload() {'));
  assert.match(unload.slice(0,200),/clearTimeout\(this\.coachRetryTimer\)/,'离开页面要把定时器清掉');
});
