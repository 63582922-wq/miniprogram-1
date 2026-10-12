const test=require("node:test");
const assert=require("node:assert");


test('选照片的遮罩必须晚于隐私授权，不能盖住「同意并继续」',()=>{
 // 隐私弹窗渲染在 page-nav-bar 组件里，被 :host 的 z-index:50 困住
 // （组件内部写的 999 对外只有 50），压不过页面里 90/91 的遮罩。
 // 所以「正在保存照片…」一旦在选照片之前出现，就会盖住隐私弹窗的
 // 「同意并继续」按钮，用户点不动、也退不出。
 const fs=require('fs');
 const src=fs.readFileSync('miniprogram/pages/project/detail/index.js','utf8');
 const start=src.indexOf('async chooseCaptureSource');
 assert.ok(start>0,'chooseCaptureSource 必须存在');
 const body=src.slice(start, src.indexOf('\n  },', start));
 const atPick=body.indexOf('choosePhotoFiles(');
 const atMask=body.indexOf('capturePicking:true');
 assert.ok(atPick>0,'函数里必须调用 choosePhotoFiles');
 assert.ok(atMask>0,'函数里必须显示保存遮罩');
 assert.ok(atMask>atPick,
   '「正在保存照片」遮罩必须等照片选完再显示——早于隐私授权会盖住同意按钮');
 // 遮罩仍然只由这一个函数控制，避免别处又提前打开
 const all=[...src.matchAll(/capturePicking:\s*true/g)];
 assert.equal(all.length,1,'capturePicking 只应在一处置真');
});

test('导航栏组件宿主不能建层叠上下文，否则隐私弹窗会被页面遮罩盖住',()=>{
 // 隐私指引弹窗渲染在 page-nav-bar 里，写的是 z-index:999。
 // 但 :host 上原先挂着 position:sticky —— sticky 会创建层叠上下文，
 // 那个 999 就被困在宿主的 z-index:50 里，对外实际只有 50，
 // 压不过页面里 z-index:90/91 的遮罩，真机上「同意并继续」点不动。
 // 粘性必须留在内层 .page-nav-bar 上。
 const fs=require('fs');
 const css=fs.readFileSync('miniprogram/components/page-nav-bar/index.wxss','utf8');
 const hostMatch=css.match(/:host\{[^}]*\}/);
 assert.ok(hostMatch,':host 规则必须存在');
 const host=hostMatch[0];
 for(const trap of ['position','z-index','transform','opacity','filter','will-change']){
   assert.ok(!host.includes(trap),
     `:host 上不能有 ${trap}——会创建层叠上下文，把组件内的隐私弹窗困住`);
 }
 assert.ok(/\.page-nav-bar\{[^}]*position:sticky/.test(css),
   '粘性要落在 .page-nav-bar 内层，导航栏才仍然吸顶');
 assert.ok(/\.privacy-mask\{[^}]*z-index:999/.test(css),
   '隐私弹窗必须保持 999，才能真正盖过页面遮罩');
});

test('连做三份报告，引导只在第一份出现（长期使用，不是单次链路）',()=>{
 // 账号持有人在真机上建第二份报告时，已经走完的操作引导又冒出来了。
 // 根因：advanceCoach 不检查引导是否还在进行，只要 getNextCoachStep
 // 还能返回下一步就 moveCoach——而 moveCoach 会把 active 重新置真。
 // 于是每建一份新报告，页面照常调用同样的钩子，引导就被复活一次。
 const store={};
 global.wx={getStorageSync:k=>store[k],setStorageSync:(k,v)=>{store[k]=v;},removeStorageSync:k=>{delete store[k];}};
 delete require.cache[require.resolve('../miniprogram/utils/coach.js')];
 delete require.cache[require.resolve('../miniprogram/utils/coach-page.js')];
 const coach=require('../miniprogram/utils/coach.js');
 const {coachMethods}=require('../miniprogram/utils/coach-page.js');

 const fakePage=()=>({data:{},setData(d){Object.assign(this.data,d);},selectComponent:()=>null,
   ...coachMethods('capturePickPhoto','#whatever')});

 // 第 1 份报告：把 9 步走完
 coach.startCoach(coach.COACH_STEPS[0]);
 assert.equal(coach.getCoachState().active,true,'开始时应处于引导中');
 for(let i=0;i<coach.COACH_STEPS.length;i++){
   const page=fakePage();
   page.advanceCoach(coach.COACH_STEPS[i]);
 }
 assert.equal(coach.getCoachState().active,false,'走完最后一步后引导应结束');

 // 第 2、3 份报告：用户照常干活，页面照常调用同样的钩子
 for(const round of [2,3]){
   for(const step of coach.COACH_STEPS){
     const page=fakePage();
     page.advanceCoach(step);
     assert.equal(coach.getCoachState().active,false,
       `第 ${round} 份报告时引导不该被重新激活（动作：${step}）`);
   }
   // 用户中途点「跳过」也不该影响后续
   const page=fakePage();
   page.handleCoachSkip();
   assert.equal(coach.getCoachState().active,false,`第 ${round} 份报告跳过引导后仍应保持结束`);
 }
});

test('引导进行中时，对不上的动作要跳过而不是原地不动',()=>{
 const store={};
 global.wx={getStorageSync:k=>store[k],setStorageSync:(k,v)=>{store[k]=v;},removeStorageSync:k=>{delete store[k];}};
 delete require.cache[require.resolve('../miniprogram/utils/coach.js')];
 delete require.cache[require.resolve('../miniprogram/utils/coach-page.js')];
 const coach=require('../miniprogram/utils/coach.js');
 const {coachMethods}=require('../miniprogram/utils/coach-page.js');
 coach.startCoach(coach.COACH_STEPS[2]);
 const page={data:{},setData(d){Object.assign(this.data,d);},selectComponent:()=>null,
   ...coachMethods(coach.COACH_STEPS[2],'#x')};
 // 用户跳着操作：直接做了第 5 步。
 // 早前这里是「对不上就不动」，结果引导永远推进不了、卡在 active，
 // 页面上剩一块找不到目标的灰罩，什么都点不了。
 // 现在必须往前走——用户既然做完了第 5 步，前面几步就已经过时了。
 page.advanceCoach(coach.COACH_STEPS[5]);
 const afterSkip=coach.getCoachState().step;
 assert.notEqual(afterSkip,coach.COACH_STEPS[2],'跳着做也不能原地不动');
 assert.ok(coach.COACH_STEPS.indexOf(afterSkip)>5,'应直接跳到第 5 步之后');
 // 做对当前这一步：正常前进一格
 const now=coach.getCoachState().step;
 page.advanceCoach(now);
 assert.equal(coach.COACH_STEPS.indexOf(coach.getCoachState().step),
   coach.COACH_STEPS.indexOf(now)+1,'做对当前步骤前进一格');
});

test('引导找不到目标时不能把用户困在灰屏里',()=>{
 // 真机事故：上传照片后引导弹出、一闪、然后整屏灰、什么都点不了，
 // 只能返回；引导状态存在 storage 里，退出去重进还是一样。
 // 两处病根：
 //  1. 无洞时渲染的是一块能吃事件的整屏遮罩——提示一旦没渲染出来，
 //     用户就只剩灰色，连"跳过引导"都点不到。
 //  2. advanceCoach 在步骤对不上时"不动"，于是引导永远推进不了、
 //     一直停在 active。
 const fs=require('fs');
 const wxml=fs.readFileSync('miniprogram/components/coach-overlay/index.wxml','utf8');
 const wxss=fs.readFileSync('miniprogram/components/coach-overlay/index.wxss','utf8');
 // 无洞那一支必须带放过触摸的类，且该类确实定义了 pointer-events:none
 assert.match(wxml,/wx:else class="coach__mask coach__mask--passthrough"/,
   '没有洞的整屏遮罩必须放过触摸，否则提示没出来时用户无路可走');
 assert.match(wxss,/\.coach__mask--passthrough\{[^}]*pointer-events:\s*none/,
   'coach__mask--passthrough 必须真的放过触摸');
 // 有洞那一支仍然吃掉触摸（洞本身不渲染元素），不能被误改成 passthrough
 assert.ok(!/wx:if="\{\{hole\}\}"[\s\S]{0,600}passthrough/.test(wxml),
   '有洞时的四块遮罩要维持原样，不能一起放过触摸');
});

test('引导推进只能向前，跳着操作也要能走完',()=>{
 const store={};
 global.wx={getStorageSync:k=>store[k],setStorageSync:(k,v)=>{store[k]=v;},removeStorageSync:k=>{delete store[k];}};
 delete require.cache[require.resolve('../miniprogram/utils/coach.js')];
 delete require.cache[require.resolve('../miniprogram/utils/coach-page.js')];
 const coach=require('../miniprogram/utils/coach.js');
 const {coachMethods}=require('../miniprogram/utils/coach-page.js');
 // 停在很靠前的一步，然后用户直接做后面的动作
 coach.startCoach(coach.COACH_STEPS[2]);
 for(const later of [coach.COACH_STEPS[5],coach.COACH_STEPS[7],coach.COACH_STEPS[8]]){
   const page={data:{},setData(d){Object.assign(this.data,d);},...coachMethods(later,'#x')};
   page.advanceCoach(later);
 }
 assert.equal(coach.getCoachState().active,false,
   '把最后一步做完后引导必须结束——不能因为中间步骤对不上就永远卡在 active');
 // 而且中途每一步都要真的往前走
 coach.startCoach(coach.COACH_STEPS[0]);
 const before=coach.getCoachState().step;
 const page={data:{},setData(d){Object.assign(this.data,d);},...coachMethods(coach.COACH_STEPS[4],'#x')};
 page.advanceCoach(coach.COACH_STEPS[4]);
 assert.notEqual(coach.getCoachState().step,before,'跳着做也要往前走，不能原地不动');
});
