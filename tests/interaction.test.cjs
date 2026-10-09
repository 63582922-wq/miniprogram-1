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
