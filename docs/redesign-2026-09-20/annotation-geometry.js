/* One image coordinate system for interactive drawing, preview and export. */
(function(root,factory){const api=factory();if(typeof module==='object')module.exports=api;else root.AnnotationGeometry=api})(typeof window==='object'?window:globalThis,()=>{
 const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
 const toImage=(p,v)=>({x:(p.x-v.x)/v.scale,y:(p.y-v.y)/v.scale});
 const toScreen=(p,v)=>({x:p.x*v.scale+v.x,y:p.y*v.scale+v.y});
 const normalize=(p,w,h)=>({x:clamp(p.x/w,0,1),y:clamp(p.y/h,0,1)});
 const pixel=(p,w,h)=>({x:p.x*w,y:p.y*h});
 function zoomAt(v,p,newScale){const q=toImage(p,v);return{x:p.x-q.x*newScale,y:p.y-q.y*newScale,scale:newScale}}
 function translate(shape,dx,dy){const pts=shape.type==='point'?[shape.a]:[shape.a,shape.b];dx=clamp(dx,-Math.min(...pts.map(p=>p.x)),1-Math.max(...pts.map(p=>p.x)));dy=clamp(dy,-Math.min(...pts.map(p=>p.y)),1-Math.max(...pts.map(p=>p.y)));return{...shape,a:{x:shape.a.x+dx,y:shape.a.y+dy},b:{x:shape.b.x+dx,y:shape.b.y+dy}}}
 function segmentDistance(p,a,b){const dx=b.x-a.x,dy=b.y-a.y,t=clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1),0,1);return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)}
 return{clamp,toImage,toScreen,normalize,pixel,zoomAt,translate,segmentDistance};
});
