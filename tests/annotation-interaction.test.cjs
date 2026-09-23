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
