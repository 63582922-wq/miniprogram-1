const G=require("../../utils/annotation-geometry");
const {getWindowInfo}=require("../../utils/system");
const {stripJpegMetadata,orientationTransform}=require("../../utils/image-orientation");
const copy=x=>JSON.parse(JSON.stringify(x));
Component({
 properties:{
  imageUrl:{type:String,observer(){if(this.canvas)this.loadImage();}},
  // imageUrl and value are bound independently by the renderer. On a cold
  // reopen, the image can finish decoding before the saved geometry arrives.
  // Observe that late value rather than treating the empty initial value as
  // authoritative. The equality check also prevents our own change event
  // from resetting undo history after every draw.
  value:{type:Array,value:[],observer(next){
   if(!this.image||!this.iw||!this.ih||this.gesture)return;
   const incoming=this.normalizePointShapes(G.legacy(next||[],this.iw,this.ih,this.properties.legacyStage));
   if(JSON.stringify(incoming)===JSON.stringify(this.shapes||[]))return;
   this.shapes=incoming;this.undoStack=[];this.redoStack=[];
   this.setData({selected:"",selectedType:""});this.draw();
  }},
  legacyStage:{type:Object,value:null}
 },
 // Start in the visible, non-destructive selection mode. The legacy point
 // tool is intentionally not exposed by the current toolbar; defaulting to it
 // left every visible tool unselected and made an initial tap create a mark.
 data:{tool:"select",ready:false,error:"",selected:"",selectedType:"",pointAspectLocked:true,showNudge:false,zoom:100,canUndo:false,canRedo:false,hint:"双指缩放，选择后拖动白色端点",workingSize:"",regionChoiceOpen:false},
 lifetimes:{ready(){this.createSelectorQuery().select("#stage").fields({node:true,size:true,rect:true}).exec(async result=>{
   const r=result[0];if(!r?.node)return;this.canvas=r.node;this.ctx=r.node.getContext("2d");this.width=r.width;this.height=r.height;this.left=r.left||0;this.top=r.top||0;
   this.dpr=getWindowInfo().pixelRatio||1;this.canvas.width=Math.round(r.width*this.dpr);this.canvas.height=Math.round(r.height*this.dpr);
   this.undoStack=[];this.redoStack=[];await this.loadImage();
 });}},
 methods:{
  async loadImage(){
   if(!this.properties.imageUrl)return;
   const loadToken=this.loadToken=(this.loadToken||0)+1;
   this.setData({ready:false,error:""});
   try{
    let src=this.properties.imageUrl;
    if(src.startsWith("cloud://"))src=(await wx.cloud.downloadFile({fileID:src})).tempFilePath;
    if(loadToken!==this.loadToken)return;
    const info=await wx.getImageInfo({src});
    if(loadToken!==this.loadToken)return;
    const fs=wx.getFileSystemManager();let metadata={jpeg:false,orientation:1},strippedPath="";
    const bytes=await new Promise((resolve,reject)=>fs.readFile({filePath:info.path,success:r=>resolve(r.data),fail:reject}));
    metadata=stripJpegMetadata(bytes);
    if(metadata.jpeg){
      strippedPath=wx.env.USER_DATA_PATH+"/annotation-decode-"+Date.now()+".jpg";
      await new Promise((resolve,reject)=>fs.writeFile({filePath:strippedPath,data:metadata.buffer,success:resolve,fail:reject}));
    }
    let image=this.canvas.createImage();
    try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=strippedPath||info.path;});}
    finally{if(strippedPath)fs.unlink({filePath:strippedPath,fail:()=>{}});}
    if(loadToken!==this.loadToken)return;
    const orientation=metadata.orientation;
    if(orientation!==1 && (this.properties.value||[]).length && this.properties.legacyStage?.version!==2)throw new Error("旧旋转照片的标注坐标无法可靠换算，请保留原记录并重新添加照片");
    const w=image.width||info.width,h=image.height||info.height,oriented=orientationTransform(orientation,w,h),ratio=Math.min(1,2400/Math.max(oriented.width,oriented.height));
    if(orientation!==1 || ratio<1){
      const result=await new Promise(resolve=>this.createSelectorQuery().select("#export").fields({node:true}).exec(resolve));
      const node=result[0]?.node;if(!node)throw new Error("照片处理画布未就绪");
      node.width=Math.round(oriented.width*ratio);node.height=Math.round(oriented.height*ratio);
      const ctx=node.getContext("2d");ctx.scale(ratio,ratio);ctx.transform(...oriented.matrix);ctx.drawImage(image,0,0,w,h);
      const processed=await new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas:node,fileType:"png",destWidth:node.width,destHeight:node.height,success:resolve,fail:reject},this));
      const persisted=await new Promise((resolve,reject)=>fs.saveFile({tempFilePath:processed.tempFilePath,success:resolve,fail:reject}));
      image=this.canvas.createImage();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=persisted.savedFilePath;});
      if(loadToken!==this.loadToken)return;
      this.triggerEvent("normalized",{path:persisted.savedFilePath,originalPath:this.properties.imageUrl,orientation,width:node.width,height:node.height});
    }
    // Use the exact decoded image for both preview and export, avoiding independent aspectFit math.
    this.image=image;this.iw=image.width||info.width;this.ih=image.height||info.height;
    this.shapes=this.normalizePointShapes(G.legacy(this.properties.value||[],this.iw,this.ih,this.properties.legacyStage));
    this.undoStack=[];this.redoStack=[];this.setData({ready:true,workingSize:this.iw+" × "+this.ih+" px · 工作图"});
    // Loading/restoring the canvas is not an edit. Sending change/stagechange
    // here made the page mark every opened photo dirty and showed a false
    // "save annotation" confirmation even when the inspector did nothing.
    this.fit();this.triggerEvent("ready",{width:this.iw,height:this.ih,annotations:copy(this.shapes),stage:{version:2,coordinateSpace:"normalized-oriented-working-image",width:this.iw,height:this.ih}});
   }catch(e){if(loadToken!==this.loadToken)return;const message=e.message||"照片加载失败，请返回重试";this.setData({error:message,ready:false});this.triggerEvent("error",{message});}
  },
  fit(){if(!this.image)return;this.fitScale=Math.min(this.width/this.iw,this.height/this.ih)*.96;this.view={scale:this.fitScale,x:(this.width-this.iw*this.fitScale)/2,y:(this.height-this.ih*this.fitScale)/2};this.draw();},
  boundView(view){
   const displayWidth=this.iw*view.scale,displayHeight=this.ih*view.scale;
   return {
    ...view,
    x:displayWidth<=this.width?(this.width-displayWidth)/2:G.clamp(view.x,this.width-displayWidth,0),
    y:displayHeight<=this.height?(this.height-displayHeight)/2:G.clamp(view.y,this.height-displayHeight,0)
   };
  },
  point(t){return {x:t.x!==undefined?t.x:t.clientX-this.left,y:t.y!==undefined?t.y:t.clientY-this.top};},
  norm(p){return G.normalize(G.toImage(p,this.view),this.iw,this.ih);},
  pointRadius(shape){return {rx:Math.max(1,Math.abs(shape.b.x-shape.a.x)*this.iw),ry:Math.max(1,Math.abs(shape.b.y-shape.a.y)*this.ih)};},
  defaultPointShape(center){
   const maxRadius=Math.max(12,Math.min(center.x*this.iw,(1-center.x)*this.iw,center.y*this.ih,(1-center.y)*this.ih));
   const radius=Math.min(maxRadius,Math.max(28,Math.min(this.iw,this.ih)*.09)),rx=radius/this.iw,ry=radius/this.ih;
   return {a:center,b:{x:G.clamp(center.x+rx,0,1),y:G.clamp(center.y+ry,0,1)},aspectLocked:true};
  },
  translatePointShape(shape,dx,dy){
   const radius=this.pointRadius(shape),rx=radius.rx/this.iw,ry=radius.ry/this.ih;
   const x=G.clamp(shape.a.x+dx,rx,1-rx),y=G.clamp(shape.a.y+dy,ry,1-ry);
   return G.translate(shape,x-shape.a.x,y-shape.a.y);
  },
  resizePointShape(shape,point){
   let rx=Math.abs(point.x-shape.a.x)*this.iw,ry=Math.abs(point.y-shape.a.y)*this.ih;
   const availableX=Math.min(shape.a.x*this.iw,(1-shape.a.x)*this.iw);
   const availableY=Math.min(shape.a.y*this.ih,(1-shape.a.y)*this.ih);
   if(shape.aspectLocked!==false){const radius=Math.min(Math.max(rx,ry,18),availableX,availableY);rx=ry=radius;}
   else{rx=Math.min(Math.max(rx,18),availableX);ry=Math.min(Math.max(ry,18),availableY);}
   return {...shape,b:{x:G.clamp(shape.a.x+rx/this.iw,0,1),y:G.clamp(shape.a.y+ry/this.ih,0,1)}};
  },
  normalizePointShapes(shapes){return (shapes||[]).map(shape=>{
   if(shape.type!=="point")return shape;
   const missingRegion=!shape.b||Math.hypot((shape.b.x-shape.a.x)*this.iw,(shape.b.y-shape.a.y)*this.ih)<8;
   return missingRegion?{...shape,...this.defaultPointShape(shape.a)}:{...shape,aspectLocked:shape.aspectLocked!==false};
  });},
  shapeAt(p){return [...this.shapes].reverse().find(s=>{const a=G.toScreen(G.pixel(s.a,this.iw,this.ih),this.view),b=G.toScreen(G.pixel(s.b,this.iw,this.ih),this.view);
    if(s.type==="point"){
      const radius=this.pointRadius(s),rx=Math.max(24,radius.rx*this.view.scale),ry=Math.max(24,radius.ry*this.view.scale);
      const value=((p.x-a.x)*(p.x-a.x))/(rx*rx)+((p.y-a.y)*(p.y-a.y))/(ry*ry);
      return value<=1.35||Math.hypot(p.x-a.x,p.y-a.y)<24;
    }
    if(s.type==="text")return Math.hypot(p.x-a.x,p.y-a.y)<24;
    if(s.type==="arrow")return G.distance(p,a,b)<22;
    return p.x>=Math.min(a.x,b.x)-18&&p.x<=Math.max(a.x,b.x)+18&&p.y>=Math.min(a.y,b.y)-18&&p.y<=Math.max(a.y,b.y)+18;
  });},
  start(e){if(!this.data.ready)return;const touches=e.touches.map(t=>this.point(t));
   if(touches.length>=2){if(this.gesture?.before)this.shapes=this.gesture.before;const[a,b]=touches,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};this.gesture={kind:"pinch",distance:Math.hypot(a.x-b.x,a.y-b.y),scale:this.view.scale,anchor:G.toImage(mid,this.view)};this.draw();return;}
   const p=touches[0];if(!p)return;const n=this.norm(p),before=copy(this.shapes);
   if(this.data.tool==="pan"){this.gesture={kind:"pan",p,view:{...this.view}};return;}
   const hit=this.shapeAt(p);
   if(this.data.tool==="select"||(hit&&(this.data.tool==="box"||this.data.tool==="ellipse"||this.data.tool==="point"))){
    const selected=this.shapes.find(s=>s.id===this.data.selected);let handle="";
    if(selected&&selected.id===hit?.id){
      const keys=selected.type==="point"?["b"]:["a","b"];
      for(const key of keys){const q=G.toScreen(G.pixel(selected[key],this.iw,this.ih),this.view);if(Math.hypot(p.x-q.x,p.y-q.y)<24){handle=key;break;}}
    }
    const s=handle?selected:hit;this.setData({selected:s?s.id:"",selectedType:s?s.type:"",pointAspectLocked:s?.type==="point"?s.aspectLocked!==false:true});
    this.gesture=s?{kind:handle?"handle":"move",handle,before,original:copy(s),id:s.id,start:n}:{kind:"pan",p,view:{...this.view}};this.draw();return;
   }
   const pixel=G.toImage(p,this.view);if(pixel.x<0||pixel.y<0||pixel.x>this.iw||pixel.y>this.ih)return;
   const s={id:"mark-"+Date.now()+"-"+Math.random().toString(36).slice(2),type:this.data.tool,a:n,b:{...n}};
   if(s.type==="point")Object.assign(s,this.defaultPointShape(n),{label:this.numberedShapeCount()+1});
   if(s.type==="box"||s.type==="ellipse")Object.assign(s,{numbered:true,label:this.numberedShapeCount()+1});
   this.shapes.push(s);this.setData({selected:s.id,selectedType:s.type,pointAspectLocked:s.aspectLocked!==false});this.gesture={kind:"draw",id:s.id,before,start:n,original:copy(s)};this.draw(p);
  },
  move(e){if(!this.gesture)return;const points=e.touches.map(t=>this.point(t));const p=points[0],g=this.gesture;if(!p)return;
   if(g.kind==="pinch"){if(points.length<2)return;const[a,b]=points,mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},scale=G.clamp(g.scale*Math.hypot(a.x-b.x,a.y-b.y)/(g.distance||1),this.fitScale,this.fitScale*12);this.view=this.boundView({scale,x:mid.x-g.anchor.x*scale,y:mid.y-g.anchor.y*scale});this.draw();return;}
   if(g.kind==="pan"){this.view=this.boundView({...g.view,x:g.view.x+p.x-g.p.x,y:g.view.y+p.y-g.p.y});this.draw();return;}
   const s=this.shapes.find(s=>s.id===g.id);if(!s)return;const n=this.norm(p);
   if(g.kind==="draw"){if(s.type==="point")Object.assign(s,this.resizePointShape(g.original,n));else s.b=n;}
   if(g.kind==="move")Object.assign(s,s.type==="point"?this.translatePointShape(g.original,n.x-g.start.x,n.y-g.start.y):G.translate(g.original,n.x-g.start.x,n.y-g.start.y));
   if(g.kind==="handle"){
    if(s.type==="point"&&g.handle==="b"){
      Object.assign(s,this.resizePointShape(s,n));
    }else{
      const o=g.original[g.handle];s[g.handle]={x:G.clamp(o.x+n.x-g.start.x,0,1),y:G.clamp(o.y+n.y-g.start.y,0,1)};
    }
   }
   this.draw(p);
  },
  end(e){const g=this.gesture;if(!g)return;if(g.kind==="pinch"&&e.touches.length>=2)return;
   // Let the remaining finger continue as a pan when a pinch ends. This makes
   // inspecting a zoomed detail feel continuous instead of requiring a full
   // lift-and-touch cycle between zooming and repositioning the photo.
   if(g.kind==="pinch"&&e.touches.length===1){this.gesture={kind:"pan",p:this.point(e.touches[0]),view:{...this.view}};return;}
   if(g.before){if(e.type==="touchcancel")this.shapes=g.before;
    else{const s=this.shapes.find(s=>s.id===g.id);if(g.kind==="draw"&&s&&s.type!=="point"&&Math.hypot((s.a.x-s.b.x)*this.iw,(s.a.y-s.b.y)*this.ih)*this.view.scale<5)this.shapes=g.before;}
    this.commit(g.before);
   }this.gesture=null;this.draw();
  },
  commit(before){if(JSON.stringify(before)!==JSON.stringify(this.shapes)){this.undoStack.push(before);if(this.undoStack.length>80)this.undoStack.shift();this.redoStack=[];this.emit();}this.draw();},
  emit(){this.triggerEvent("change",copy(this.shapes));this.triggerEvent("stagechange",{version:2,coordinateSpace:"normalized-oriented-working-image",width:this.iw,height:this.ih});},
  scene(ctx,v){ctx.save();ctx.translate(v.x,v.y);ctx.scale(v.scale,v.scale);ctx.drawImage(this.image,0,0,this.iw,this.ih);G.render(ctx,this.shapes,this.iw,this.ih);ctx.restore();},
  draw(lens){
   if(!this.image||!this.view)return;const c=this.ctx;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.fillStyle="#DDD6CC";c.fillRect(0,0,this.width,this.height);this.scene(c,this.view);
   const s=this.shapes.find(s=>s.id===this.data.selected);
   if(s)for(const k of (s.type==="point"?["b"]:["a","b"])){const p=G.toScreen(G.pixel(s[k],this.iw,this.ih),this.view);c.beginPath();c.arc(p.x,p.y,7,0,Math.PI*2);c.fillStyle="#fff";c.fill();c.strokeStyle="#C13D2A";c.lineWidth=2;c.stroke();}
   if(lens){const size=112,x=lens.x<this.width/2?this.width-size-12:12,y=12,q=G.toImage(lens,this.view),scale=this.view.scale*2.5;c.save();c.beginPath();c.rect(x,y,size,size);c.clip();c.fillStyle="#DDD6CC";c.fillRect(x,y,size,size);this.scene(c,{x:x+size/2-q.x*scale,y:y+size/2-q.y*scale,scale});c.strokeStyle="#191816";c.lineWidth=1;c.beginPath();c.moveTo(x+size/2-10,y+size/2);c.lineTo(x+size/2+10,y+size/2);c.moveTo(x+size/2,y+size/2-10);c.lineTo(x+size/2,y+size/2+10);c.stroke();c.restore();c.strokeRect(x,y,size,size);}
   this.setData({zoom:Math.round(this.view.scale/this.fitScale*100),canUndo:!!this.undoStack.length,canRedo:!!this.redoStack.length});
  },
  numberedShapeCount(){return this.shapes.filter(s=>s.type==="point"||((s.type==="box"||s.type==="ellipse")&&s.numbered)).length;},
  chooseRegionType(){this.setData({regionChoiceOpen:true});},
  chooseBoxRegion(){this.activateRegionType("box");},
  chooseEllipseRegion(){this.activateRegionType("ellipse");},
  closeRegionChoice(){this.setData({regionChoiceOpen:false});},
  activateRegionType(type){if(this.gesture?.before)this.shapes=this.gesture.before;this.gesture=null;this.setData({tool:type,selected:"",selectedType:"",regionChoiceOpen:false});this.draw();},
  setTool(e){if(this.gesture?.before)this.shapes=this.gesture.before;this.gesture=null;this.setData({tool:e.currentTarget.dataset.tool,selected:"",selectedType:""});this.draw();},
  undo(){if(!this.undoStack.length)return;this.redoStack.push(copy(this.shapes));this.shapes=this.undoStack.pop();this.setData({selected:"",selectedType:""});this.emit();this.draw();},
  redo(){if(!this.redoStack.length)return;this.undoStack.push(copy(this.shapes));this.shapes=this.redoStack.pop();this.setData({selected:"",selectedType:""});this.emit();this.draw();},
  remove(){if(!this.data.selected)return;const before=copy(this.shapes);this.shapes=this.shapes.filter(s=>s.id!==this.data.selected);this.setData({selected:"",selectedType:""});this.commit(before);},
  setPointAspect(e){
   const selected=this.shapes.find(s=>s.id===this.data.selected);if(!selected||selected.type!=="point")return;
   const locked=e.currentTarget.dataset.mode==="circle",before=copy(this.shapes);selected.aspectLocked=locked;
   if(locked){const available=Math.min(selected.a.x*this.iw,(1-selected.a.x)*this.iw,selected.a.y*this.ih,(1-selected.a.y)*this.ih),radius=Math.min(available,Math.max(this.pointRadius(selected).rx,this.pointRadius(selected).ry));selected.b={x:G.clamp(selected.a.x+radius/this.iw,0,1),y:G.clamp(selected.a.y+radius/this.ih,0,1)};}
   this.setData({pointAspectLocked:locked,tool:"select"});this.commit(before);
  },
  toggleNudge(){this.setData({showNudge:!this.data.showNudge});},
  nudge(e){const [x,y]=e.currentTarget.dataset.delta.split(",").map(Number),before=copy(this.shapes);this.shapes=this.shapes.map(s=>s.id===this.data.selected?(s.type==="point"?this.translatePointShape(s,x/this.iw,y/this.ih):G.translate(s,x/this.iw,y/this.ih)):s);this.commit(before);},
  zoom(e){if(!this.view)return;this.view=this.boundView(G.zoomAt(this.view,{x:this.width/2,y:this.height/2},G.clamp(this.view.scale*Number(e.currentTarget.dataset.factor),this.fitScale,this.fitScale*12)));this.draw();},
  async exportImage(){
   if(!this.data.ready)throw new Error(this.data.error||"图片未就绪");
   const result=await new Promise(resolve=>this.createSelectorQuery().select("#export").fields({node:true}).exec(resolve));
   const node=result[0]?.node;if(!node)throw new Error("导出画布未就绪");
   const ratio=Math.min(1,2400/Math.max(this.iw,this.ih));node.width=Math.round(this.iw*ratio);node.height=Math.round(this.ih*ratio);
   const ctx=node.getContext("2d");ctx.clearRect(0,0,node.width,node.height);this.scene(ctx,{x:0,y:0,scale:ratio});
   return new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas:node,fileType:"png",destWidth:node.width,destHeight:node.height,success:r=>resolve(r.tempFilePath),fail:reject},this));
  }
 }
});
