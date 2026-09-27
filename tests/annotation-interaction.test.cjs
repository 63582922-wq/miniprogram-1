const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const G=require('../miniprogram/utils/annotation-geometry'),O=require('../miniprogram/utils/image-orientation');
function editor(){let config;vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/components/annotation-canvas/index.js'),'utf8'),{Component:x=>config=x,require:n=>n.includes('annotation-geometry')?G:n.includes('image-orientation')?O:{},wx:{},Date,Math});
 return {...config.methods,data:{...config.data,ready:true,tool:'box'},shapes:[],undoStack:[],redoStack:[],iw:1000,ih:500,width:400,height:300,fitScale:.4,view:{scale:.4,x:0,y:50},setData(p){Object.assign(this.data,p)},draw(){},emit(){this.emitted=structuredClone(this.shapes)}};}
const event=(points,type='touchmove')=>({type,touches:points.map(([x,y])=>({x,y}))});
test('second finger cancels pending stroke, pinch anchor is stable, no ghost annotation',()=>{
 const e=editor();e.start(event([[100,100]],'touchstart'));e.move(event([[200,180]]));assert.equal(e.shapes.length,1);
 e.start(event([[100,100],[200,100]],'touchstart'));assert.equal(e.shapes.length,0);
 const before=G.toImage({x:150,y:100},e.view);e.move(event([[50,100],[250,100]]));const after=G.toImage({x:150,y:100},e.view);
 assert.deepEqual(after,before);e.end(event([],'touchend'));assert.equal(e.undoStack.length,0);assert.equal(e.shapes.length,0);
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
test('one tap creates a numbered region and the outer handle switches between circle and ellipse',()=>{
 const e=editor();e.data.tool='point';e.start(event([[160,150]],'touchstart'));e.end(event([],'touchend'));
 assert.equal(e.shapes.length,1);const point=e.shapes[0];assert.equal(point.type,'point');assert.equal(point.aspectLocked,true);
 let radius=e.pointRadius(point);assert.ok(Math.abs(radius.rx-radius.ry)<1e-8);assert.ok(radius.rx>=28);
 e.data.tool='select';e.data.selected=point.id;e.data.selectedType='point';
 let handle=G.toScreen(G.pixel(point.b,e.iw,e.ih),e.view);e.start(event([[handle.x,handle.y]],'touchstart'));e.move(event([[handle.x+45,handle.y+10]]));e.end(event([],'touchend'));
 radius=e.pointRadius(point);assert.ok(Math.abs(radius.rx-radius.ry)<1e-8,'locked resize stays circular in image pixels');
 e.setPointAspect({currentTarget:{dataset:{mode:'ellipse'}}});assert.equal(point.aspectLocked,false);
 handle=G.toScreen(G.pixel(point.b,e.iw,e.ih),e.view);e.start(event([[handle.x,handle.y]],'touchstart'));e.move(event([[handle.x+35,handle.y+8]]));e.end(event([],'touchend'));
 radius=e.pointRadius(point);assert.notEqual(Math.round(radius.rx),Math.round(radius.ry));
});
test('number marker follows a one-finger placement drag in image coordinates',()=>{
 const e=editor();e.data.tool='point';e.start(event([[120,130]],'touchstart'));const before=structuredClone(e.shapes[0]);
 e.move(event([[160,150]]));e.end(event([],'touchend'));
 const after=e.shapes[0];assert.ok(Math.abs(after.a.x-before.a.x-.1)<1e-8);assert.ok(Math.abs(after.a.y-before.a.y-.1)<1e-8);
 assert.ok(Math.abs((after.b.x-before.b.x)-.1)<1e-8);assert.ok(Math.abs((after.b.y-before.b.y)-.1)<1e-8);
});
test('photo pan is bounded so the image cannot be lost outside the viewport',()=>{
 const e=editor();e.data.tool='pan';e.start(event([[200,150]],'touchstart'));e.move(event([[1200,900]]));
 assert.equal(e.view.x,0);assert.equal(e.view.y,50);
 e.view={scale:.8,x:-200,y:-50};e.start(event([[200,150]],'touchstart'));e.move(event([[-1000,-900]]));
 assert.equal(e.view.x,-400);assert.equal(e.view.y,-100);
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
