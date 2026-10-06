const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../miniprogram/utils/annotation-geometry'),O=require('../miniprogram/utils/image-orientation');
function editor(){let config;vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.js'),'utf8'),{Component:x=>config=x,require:n=>n.includes('annotation-geometry')?G:n.includes('image-orientation')?O:{},wx:{},Date,Math});
 return {...config.methods,data:{...config.data,ready:true,tool:'box'},shapes:[],undoStack:[],redoStack:[],iw:1000,ih:500,width:400,height:300,fitScale:.4,view:{scale:.4,x:0,y:50},setData(p){Object.assign(this.data,p)},draw(){},emit(){this.emitted=structuredClone(this.shapes)},triggerEvent(name){this.lastEvent=name}};}
test('annotation opens in the visible, non-destructive selection mode',()=>{
 let config;vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.js'),'utf8'),{Component:x=>config=x,require:n=>n.includes('annotation-geometry')?G:n.includes('image-orientation')?O:{},wx:{},Date,Math});
 const markup=fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.wxml'),'utf8');
 assert.equal(config.data.tool,'select');
 assert.match(markup,/class="(?:ui-button-reset )?tool \{\{tool==='select'\?'tool--active':''\}\}"/);
});
const event=(points,type='touchmove')=>({type,touches:points.map(([x,y])=>({x,y}))});
test('second finger cancels pending stroke, pinch anchor is stable, no ghost annotation',()=>{
 const e=editor();e.start(event([[100,100]],'touchstart'));e.move(event([[200,180]]));assert.equal(e.shapes.length,1);
 e.start(event([[100,100],[200,100]],'touchstart'));assert.equal(e.shapes.length,0);
 const before=G.toImage({x:150,y:100},e.view);e.move(event([[50,100],[250,100]]));const after=G.toImage({x:150,y:100},e.view);
 assert.deepEqual(after,before);e.end(event([],'touchend'));assert.equal(e.undoStack.length,0);assert.equal(e.shapes.length,0);
});
test('one remaining finger can continue panning immediately after a pinch',()=>{
 const e=editor();e.data.tool='pan';
 e.start(event([[100,100],[200,100]],'touchstart'));
 e.move(event([[70,100],[230,100]]));
 const zoomed={...e.view};
 e.end(event([[70,100]],'touchend'));
 e.move(event([[45,90]]));
 assert.equal(e.view.scale,zoomed.scale);
 assert.equal(e.view.x,zoomed.x-25);
 assert.equal(e.view.y,zoomed.y-10);
 e.end(event([],'touchend'));
});
test('draw, select/move, undo/redo, delete and one-pixel nudge preserve geometry',()=>{
 const e=editor();e.start(event([[100,100]],'touchstart'));e.move(event([[200,180]]));e.end(event([],'touchend'));assert.equal(e.shapes.length,1);assert.equal(e.undoStack.length,1);
 const first=JSON.stringify(e.shapes);e.undo();assert.equal(e.shapes.length,0);e.redo();assert.equal(JSON.stringify(e.shapes),first);
 e.data.selected=e.shapes[0].id;const x=e.shapes[0].a.x;e.nudge({currentTarget:{dataset:{delta:'1,0'}}});assert.ok(Math.abs(e.shapes[0].a.x-x-.001)<1e-8);
 e.remove();assert.equal(e.shapes.length,0);e.undo();assert.equal(e.shapes.length,1);
});
test('only number points receive visible contiguous labels',()=>{
 const labels=[];
 const ctx=new Proxy({}, {get(target,key){
  if(key==='fillText')return value=>labels.push(String(value));
  if(key in target)return target[key];
  return ()=>{};
 },set(target,key,value){target[key]=value;return true;}});
 G.render(ctx,[
  {id:'box',type:'box',a:{x:.1,y:.1},b:{x:.3,y:.3},label:8},
  {id:'arrow',type:'arrow',a:{x:.2,y:.6},b:{x:.6,y:.6},label:9},
  {id:'point-a',type:'point',a:{x:.4,y:.4},b:{x:.4,y:.4},label:3},
  {id:'ellipse',type:'ellipse',a:{x:.5,y:.2},b:{x:.8,y:.5},label:10},
  {id:'point-b',type:'point',a:{x:.7,y:.7},b:{x:.7,y:.7},label:12}
 ],1000,500);
 assert.deepEqual(labels,['1','2']);
});
test('rectangular and elliptical selections receive contiguous issue numbers and render their own labels',()=>{
 const e=editor();e.data.tool='box';e.start(event([[80,85]],'touchstart'));e.move(event([[170,155]]));e.end(event([],'touchend'));
 assert.equal(e.shapes[0].type,'box');assert.equal(e.shapes[0].numbered,true);assert.equal(e.shapes[0].label,1);
 e.data.tool='ellipse';e.start(event([[220,90]],'touchstart'));e.move(event([[340,175]]));e.end(event([],'touchend'));
 assert.equal(e.shapes[1].type,'ellipse');assert.equal(e.shapes[1].numbered,true);assert.equal(e.shapes[1].label,2);
 const labels=[];const ctx=new Proxy({}, {get(target,key){if(key==='fillText')return value=>labels.push(String(value));return key in target?target[key]:()=>{};},set(target,key,value){target[key]=value;return true;}});
 G.render(ctx,e.shapes,1000,500);assert.deepEqual(labels,['1','2']);
});
test('region outlines use fine dark and white keylines under the unchanged red stroke for photo contrast',()=>{
 const strokes=[];const state={};
 const ctx=new Proxy(state,{get(target,key){if(key==='stroke')return ()=>strokes.push({color:target.strokeStyle,width:target.lineWidth});return key in target?target[key]:(()=>{});},set(target,key,value){target[key]=value;return true;}});
 G.render(ctx,[{id:'box',type:'box',a:{x:.1,y:.1},b:{x:.4,y:.4},numbered:true}],1000,500);
 assert.deepEqual(strokes.slice(0,3).map(s=>s.color),['#191816','#FFFFFF','#C13D2A']);
 assert.ok(Math.abs(strokes[0].width-3.6)<1e-8);
 assert.ok(Math.abs(strokes[1].width-2.4)<1e-8);
 assert.equal(strokes[2].width,1.5,'the visible red stroke remains unchanged');
});
test('the single region control opens an in-app themed choice and assigns issue numbers on drag',()=>{
 const e=editor();
 const config={};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.js'),'utf8'),{Component:x=>Object.assign(config,x),require:n=>n.includes('annotation-geometry')?G:n.includes('image-orientation')?O:{},wx:{},Date,Math});
 e.data.regionChoiceOpen=false;
 config.methods.chooseRegionType.call(e);
 assert.equal(e.data.regionChoiceOpen,true);
 config.methods.chooseEllipseRegion.call(e);
 assert.equal(e.data.tool,'ellipse');
 assert.equal(e.data.regionChoiceOpen,false);
 config.methods.chooseRegionType.call(e);
 config.methods.closeRegionChoice.call(e);
 assert.equal(e.data.regionChoiceOpen,false,'cancel closes the in-app sheet without changing selected tool');
 e.start(event([[160,110]],'touchstart'));e.move(event([[260,210]]));e.end(event([],'touchend'));
 assert.equal(e.shapes.length,1);assert.equal(e.shapes[0].type,'ellipse');assert.equal(e.shapes[0].numbered,true);assert.equal(e.shapes[0].label,1);
});
test('region choice belongs to the shared linen UI system and has no native white action sheet dependency',()=>{
 const source=fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.js'),'utf8');
 const markup=fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.wxml'),'utf8');
 const css=fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.wxss'),'utf8');
 assert.doesNotMatch(source,/showActionSheet/);
 assert.match(markup,/regionChoiceOpen/);
 assert.match(markup,/矩形/);assert.match(markup,/椭圆/);
 assert.match(markup,/class="(?:ui-button-reset )?region-choice__option \{\{tool==='box'\?'region-choice__option--active':''\}\}" bindtap="chooseBoxRegion"/);
 assert.match(markup,/class="(?:ui-button-reset )?region-choice__option \{\{tool==='ellipse'\?'region-choice__option--active':''\}\}" bindtap="chooseEllipseRegion"/);
 assert.match(markup,/wx:if="\{\{tool==='box'\}\}" class="region-choice__current">当前/);
 assert.match(markup,/wx:if="\{\{tool==='ellipse'\}\}" class="region-choice__current">当前/);
 assert.match(markup,/tool==='ellipse'\?'\/images\/icons\/annotation-circle\.svg':'\/images\/icons\/annotation-rectangle\.svg'/,'the active region shape must be reflected in the single toolbar control');
 assert.doesNotMatch(markup,/region-choice__number|<cover-view[^>]*>1<\/cover-view>/,'the selector must not imply that shape type is a fixed issue number');
 assert.doesNotMatch(markup,/class="region-choice__option" data-type=/);
 assert.match(css,/\.region-choice__sheet[^}]*background:\s*var\(--a-paper\)/s);
 assert.match(css,/\.region-choice__option[^}]*height:\s*calc\(var\(--a-space-7\) \* 2\)/s);
 assert.match(css,/\.region-choice__option--active\s*\{[^}]*background:\s*var\(--a-accent-wash\)/s);
 assert.match(css,/\.region-choice__current\s*\{[^}]*background:\s*var\(--a-accent\)/s);
 assert.match(markup,/<cover-view[^>]*class="region-choice"[^>]*bindtap="closeRegionChoice"/);
 assert.match(markup,/<cover-view[^>]*class="region-choice__sheet"/);
 assert.match(markup,/<cover-image[^>]*annotation-(?:rectangle|circle)\.svg/);
});
test('number region stays circular and inside image edges while resizing and dragging',()=>{
 const e=editor();e.data.tool='point';e.start(event([[160,150]],'touchstart'));e.end(event([],'touchend'));
 const point=e.shapes[0];e.data.tool='select';e.data.selected=point.id;
 const handle=G.toScreen(G.pixel(point.b,e.iw,e.ih),e.view);
 e.start(event([[handle.x,handle.y]],'touchstart'));e.move(event([[handle.x+500,handle.y+500]]));e.end(event([],'touchend'));
 let radius=e.pointRadius(point);assert.ok(Math.abs(radius.rx-radius.ry)<1e-8,'circle resize must use the most restrictive edge');
 let center=G.pixel(point.a,e.iw,e.ih);assert.ok(center.x-radius.rx>=-1e-8&&center.x+radius.rx<=e.iw+1e-8);assert.ok(center.y-radius.ry>=-1e-8&&center.y+radius.ry<=e.ih+1e-8);
 const start=G.toScreen(center,e.view);e.start(event([[start.x,start.y]],'touchstart'));e.move(event([[start.x-1000,start.y-1000]]));e.end(event([],'touchend'));
 radius=e.pointRadius(point);center=G.pixel(point.a,e.iw,e.ih);
 assert.ok(center.x-radius.rx>=-1e-8&&center.x+radius.rx<=e.iw+1e-8,'drag must keep the circle inside left/right edges');
 assert.ok(center.y-radius.ry>=-1e-8&&center.y+radius.ry<=e.ih+1e-8,'drag must keep the circle inside top/bottom edges');
});
test('dragging immediately after placing a number resizes its ring without moving its center',()=>{
 const e=editor();e.data.tool='point';e.start(event([[120,130]],'touchstart'));const before=structuredClone(e.shapes[0]);
 const radiusBefore=e.pointRadius(before);e.move(event([[160,150]]));e.end(event([],'touchend'));
 const after=e.shapes[0];assert.equal(after.a.x,before.a.x);assert.equal(after.a.y,before.a.y);
 const radiusAfter=e.pointRadius(after);assert.ok(radiusAfter.rx>radiusBefore.rx);assert.ok(Math.abs(radiusAfter.rx-radiusAfter.ry)<1e-8);
});
test('photo pan is bounded so the image cannot be lost outside the viewport',()=>{
 const e=editor();e.data.tool='pan';e.start(event([[200,150]],'touchstart'));e.move(event([[1200,900]]));
 assert.equal(e.view.x,0);assert.equal(e.view.y,50);
 e.view={scale:.8,x:-200,y:-50};e.start(event([[200,150]],'touchstart'));e.move(event([[-1000,-900]]));
 assert.equal(e.view.x,-400);assert.equal(e.view.y,-100);
});

test('annotation photo canvas expands into the available viewport instead of leaving fixed-height dead space',()=>{
 const canvasCss=fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.wxss'),'utf8');
 const pageCss=fs.readFileSync(require.resolve('../miniprogram/pages/inspection/annotate/index.wxss'),'utf8');
 assert.match(canvasCss,/\.annotation-card\s*\{[^}]*display:\s*flex;[^}]*height:\s*100%;/s);
 assert.match(canvasCss,/\.canvas-stage\s*\{[^}]*min-height:\s*240px;[^}]*flex:\s*1\s+1\s+auto;/s);
 assert.ok(pageCss.includes('.annotate-page{height:100vh;min-height:0;box-sizing:border-box;padding-bottom:0;display:flex;flex-direction:column}'));
 assert.ok(pageCss.includes('.annotate-page .annotate-canvas{display:block;width:100%;min-width:0;min-height:0;flex:1 1 auto;overflow:hidden}'));
 const pageMarkup=fs.readFileSync(require.resolve('../miniprogram/pages/inspection/annotate/index.wxml'),'utf8');
 assert.match(pageMarkup,/<annotation-canvas wx:if="\{\{imagePath\}\}" class="annotate-canvas"/);
 assert.doesNotMatch(canvasCss,/\.canvas-stage\s*\{[^}]*height:\s*44vh/s);
});
test('annotation exit has one stable entry while save remains the only primary action',()=>{
 const pageMarkup=fs.readFileSync(require.resolve('../miniprogram/pages/inspection/annotate/index.wxml'),'utf8');
 const pageScript=fs.readFileSync(require.resolve('../miniprogram/pages/inspection/annotate/index.js'),'utf8');
 const pageCss=fs.readFileSync(require.resolve('../miniprogram/pages/inspection/annotate/index.wxss'),'utf8');
 const canvasMarkup=fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.wxml'),'utf8');
 assert.match(pageMarkup,/page-nav-bar[^>]*showBack="\{\{true\}\}"[^>]*bind:backtap="handleBackTap"/);
 assert.match(pageMarkup,/class="(?:ui-button-reset )?primary-button[^\"]*"[^>]*bindtap="handleSave"[^>]*>\{\{editorReady \? '保存标注并返回'/);
 assert.match(pageMarkup,/<cover-view wx:if="\{\{leaveDialogOpen\}\}" class="annotation-exit"/);
 assert.match(pageMarkup,/annotation-exit__action--primary[^>]*bindtap="saveAndReturn"[\s\S]*?保存并返回/);
 assert.match(pageMarkup,/bindtap="closeLeaveDialog">继续编辑/);
 assert.match(pageMarkup,/annotation-exit__action--danger[^>]*bindtap="cancelEditsAndReturn"[\s\S]*?取消本次编辑/);
 assert.doesNotMatch(pageScript,/showActionSheet|showModal\(\{title:"标注未保存"/,'leave and save errors stay inside the app UI system');
 assert.match(pageCss,/\.annotation-exit__sheet[^}]*background:var\(--a-paper\)/s);
 assert.match(pageCss,/\.annotation-exit__action--primary[^}]*background:var\(--a-accent\)/s);
 assert.match(pageCss,/\.annotation-exit__action--danger[^}]*color:var\(--a-danger\)/s);
 assert.doesNotMatch(canvasMarkup,/requestExit|>返回</,'the tool rail must not repeat the page-level exit action');
});
test('late-bound saved geometry restores after image decoding without clearing an identical live canvas',()=>{
 const e=editor();e.image={};e.properties={legacyStage:null};
 const saved=[{id:'saved-mark',type:'box',a:{x:.2,y:.3},b:{x:.7,y:.8},label:1}];
 const observe=e.propertiesValueObserver||e.constructor?.properties?.value?.observer;
 // Component configuration is the source of truth; invoke the registered
 // property observer as the renderer does when value binds after imageUrl.
 const config={};vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.js'),'utf8'),{Component:x=>Object.assign(config,x),require:n=>n.includes('annotation-geometry')?G:n.includes('image-orientation')?O:{},wx:{},Date,Math});
 const observer=config.properties.value.observer;
 observer.call(e,saved);
 assert.deepEqual(e.shapes,saved);assert.equal(e.undoStack.length,0);
 e.undoStack.push([{id:'before'}]);observer.call(e,structuredClone(saved));
 assert.equal(e.undoStack.length,1);
});
