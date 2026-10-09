const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

const PROJECT_LIST_JS='miniprogram/pages/project/list/index.js';
const PROJECT_LIST_WXML='miniprogram/pages/project/list/index.wxml';
const ONBOARDING_JS='miniprogram/pages/onboarding/index.js';
const ONBOARDING_WXML='miniprogram/pages/onboarding/index.wxml';

/**
 * 使用向导曾经「存在但不可达」：项目列表 import 了引导模块、声明了
 * onboardingSeenV1 与 onboardingCheckedInSession，整个文件里却一次都没用过。
 * 结果是新用户第一次打开只看到「还没有项目」，永远不知道有向导。
 *
 * 这一组测试锁住两件事：入口真的接上了，以及引导内容覆盖的是真实使用顺序。
 */

test('every guide helper the project list imports is actually used',()=>{
  const source=read(PROJECT_LIST_JS);
  for(const modulePath of ['utils/guide','utils/coach']){
    const match=source.match(new RegExp(`const \\{([^}]+)\\} = require\\("[^"]*${modulePath.replace('/','\\/')}"\\);`));
    if(!match) continue;
    const names=match[1].split(',').map(n=>n.trim()).filter(Boolean);
    // 必须先剥掉注释再判断：说明性注释里往往会提到这些名字，
    // 直接搜全文会把「引入了却没用」误判成「用过了」——第一版测试就栽在这。
    const body=source
      .replace(match[0],'')
      .replace(/\/\*[\s\S]*?\*\//g,'')
      .replace(/\/\/[^\n]*/g,'');
    for(const name of names){
      assert.match(body,new RegExp(`\\b${name}\\b`),
        `引入了 ${name} 却从未使用——引导接线不能是死的`);
    }
  }
});

test('the empty project list offers a way into the guide',()=>{
  const markup=read(PROJECT_LIST_WXML);
  const empty=markup.slice(markup.indexOf('还没有项目'));
  assert.match(empty.slice(0,400),/bindaction="openOnboarding"/,
    '空态必须能进引导页（empty-state 组件早已支持 bindaction，此前没接）');
  assert.match(empty.slice(0,400),/actionText="\{\{onboardingActionText\}\}"/,
    '按钮文案跟着引导完成状态走');
  const script=read(PROJECT_LIST_JS);
  assert.match(script,/openOnboarding\(\)[\s\S]{0,80}pages\/onboarding\/index/,'入口要指向引导页');
  assert.match(script,/isGuideCompleted\(\)\s*\?\s*"查看使用向导"\s*:\s*"第一次用？看使用向导"/,
    '已完成的人不该再看到「第一次用？」');
});

test('the guide follows the real field order instead of listing features',()=>{
  const script=read(ONBOARDING_JS);
  const flowBlock=script.slice(script.indexOf('flow: ['),script.indexOf('tipVisible: false'));
  assert.ok(flowBlock.length>200,'引导页应有流程说明');
  const order=['拍照片','圈出问题位置','写说明','生成报告','转发给业主'];
  let cursor=-1;
  for(const title of order){
    const at=flowBlock.indexOf(title);
    assert.ok(at>0,`流程里缺少「${title}」`);
    assert.ok(at>cursor,`「${title}」的顺序不对——应按现场实际顺序排列`);
    cursor=at;
  }
});

test('the guide warns that an un-annotated problem loses its report number',()=>{
  const script=read(ONBOARDING_JS);
  assert.match(script,/没有圈位置[\s\S]{0,40}没有编号/,
    '标注是最容易被跳过、代价最大的一步，必须在引导里明说');
});

test('the guide states that AI is optional and only enters the report after review',()=>{
  const script=read(ONBOARDING_JS);
  assert.match(script,/AI识图[\s\S]{0,60}可选/,'AI 要写明是可选的');
  assert.match(script,/核对确认后才写进报告/,'AI 结果必须经人工确认才进报告——这是对用户和审核的双重承诺');
});

test('the guide renders both sections it promises',()=>{
  const markup=read(ONBOARDING_WXML);
  assert.match(markup,/先做这两件事/);
  assert.match(markup,/接下来会这么走/);
  assert.match(markup,/wx:for="\{\{flow\}\}"/,'流程说明要真的渲染出来');
});
