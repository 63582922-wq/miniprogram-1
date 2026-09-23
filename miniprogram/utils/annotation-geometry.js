const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const toImage=(p,v)=>({x:(p.x-v.x)/v.scale,y:(p.y-v.y)/v.scale});
const toScreen=(p,v)=>({x:p.x*v.scale+v.x,y:p.y*v.scale+v.y});
const normalize=(p,w,h)=>({x:clamp(p.x/w,0,1),y:clamp(p.y/h,0,1)});
const pixel=(p,w,h)=>({x:p.x*w,y:p.y*h});
function zoomAt(v,p,scale){const q=toImage(p,v);return {x:p.x-q.x*scale,y:p.y-q.y*scale,scale};}
function translate(s,dx,dy){const points=s.type==='point'?[s.a]:[s.a,s.b];dx=clamp(dx,-Math.min(...points.map(p=>p.x)),1-Math.max(...points.map(p=>p.x)));dy=clamp(dy,-Math.min(...points.map(p=>p.y)),1-Math.max(...points.map(p=>p.y)));return {...s,a:{x:s.a.x+dx,y:s.a.y+dy},b:{x:s.b.x+dx,y:s.b.y+dy}};}
function distance(p,a,b){const x=b.x-a.x,y=b.y-a.y,t=clamp(((p.x-a.x)*x+(p.y-a.y)*y)/(x*x+y*y||1),0,1);return Math.hypot(p.x-a.x-t*x,p.y-a.y-t*y);}
function valid(s){return s&&['box','ellipse','arrow','point','text'].includes(s.type)&&[s.a?.x,s.a?.y,s.b?.x,s.b?.y].every(x=>Number.isFinite(x)&&x>=0&&x<=1);}
function render(ctx,shapes,w,h){
 const line=Math.max(2,w/200),r=w/50;
 let pointNumber=0;
 shapes.forEach(s=>{if(!valid(s))return;const a=pixel(s.a,w,h),b=pixel(s.b,w,h);ctx.save();ctx.lineWidth=line;ctx.strokeStyle='#C13D2A';ctx.fillStyle='#C13D2A';ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
 if(s.type==='box')ctx.rect(Math.min(a.x,b.x),Math.min(a.y,b.y),Math.abs(a.x-b.x),Math.abs(a.y-b.y));
 if(s.type==='ellipse'){ctx.save();ctx.translate((a.x+b.x)/2,(a.y+b.y)/2);ctx.scale(Math.max(.1,Math.abs(a.x-b.x)/2),Math.max(.1,Math.abs(a.y-b.y)/2));ctx.arc(0,0,1,0,Math.PI*2);ctx.restore();}
 if(s.type==='arrow'){const angle=Math.atan2(b.y-a.y,b.x-a.x);ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.moveTo(b.x-r*1.5*Math.cos(angle-.5),b.y-r*1.5*Math.sin(angle-.5));ctx.lineTo(b.x,b.y);ctx.lineTo(b.x-r*1.5*Math.cos(angle+.5),b.y-r*1.5*Math.sin(angle+.5));}ctx.stroke();
 if(s.type==='text'){ctx.font=Math.round(w/35)+'px sans-serif';ctx.fillText(s.text||'',a.x,a.y);ctx.restore();return;}
 if(s.type!=='point'){ctx.restore();return;}
 pointNumber+=1;
 ctx.beginPath();ctx.arc(a.x,a.y,r,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=line*.4;ctx.stroke();ctx.fillStyle='#fff';ctx.font='600 '+Math.round(r*1.25)+'px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(pointNumber),a.x,a.y);ctx.restore();});
}
function legacy(items,w,h,stage){
 if(items.every(valid))return items;
 if(!stage?.width||!stage?.height)throw new Error('旧标注缺少画布尺寸，请保留原图后重新标注');
 const scale=Math.min(stage.width/w,stage.height/h),ox=(stage.width-w*scale)/2,oy=(stage.height-h*scale)/2;
 const n=(x,y)=>normalize({x:(x-ox)/scale,y:(y-oy)/scale},w,h);
 return items.map((s,i)=>({id:s.id||'legacy-'+i,type:s.tool==='text'?'text':s.tool,a:n(s.x,s.y),b:n(s.tool==='arrow'?s.x2:s.x+(s.width||0),s.tool==='arrow'?s.y2:s.y+(s.height||0)),text:s.text,label:i+1})).filter(valid);
}
module.exports={clamp,toImage,toScreen,normalize,pixel,zoomAt,translate,distance,valid,render,legacy};
