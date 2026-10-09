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
