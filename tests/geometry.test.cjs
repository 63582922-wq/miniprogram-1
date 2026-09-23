const {test}=require('node:test'),assert=require('node:assert/strict');
const G=require('../miniprogram/utils/annotation-geometry'),O=require('../miniprogram/utils/image-orientation');
test('normalized evidence coordinates survive portrait/landscape zoom, pan and export',()=>{
  for(const [w,h]of [[4032,3024],[3024,4032],[12000,3000]])for(const scale of [.04,.4,2,5]){
    const v={x:-135,y:271,scale},p={x:w*.33,y:h*.68},screen=G.toScreen(p,v),back=G.toImage(screen,v);
    assert.ok(Math.abs(back.x-p.x)<1e-8);assert.ok(Math.abs(back.y-p.y)<1e-8);
    const n=G.normalize(back,w,h),ratio=Math.min(1,2400/Math.max(w,h)),out=G.pixel(n,w*ratio,h*ratio);
    assert.ok(Math.abs(out.x-p.x*ratio)<1e-8);
    const z=G.zoomAt(v,screen,scale*2);assert.ok(Math.abs(G.toImage(screen,z).x-p.x)<1e-8);
  }
});
test('nudge clamps without distorting shape; hit tolerance does not change geometry',()=>{
  const s={type:'box',a:{x:.2,y:.3},b:{x:.5,y:.7}},m=G.translate(s,1,-1);
  assert.equal(m.b.x,1);assert.equal(m.a.y,0);assert.ok(Math.abs(m.b.x-m.a.x-.3)<1e-9);
  assert.equal(G.distance({x:5,y:4},{x:0,y:0},{x:10,y:0}),4);assert.ok(G.valid({...s}));
});
test('all eight EXIF transforms cover the upright frame exactly',()=>{
  for(let n=1;n<=8;n++){const t=O.orientationTransform(n,120,80),[a,b,c,d,e,f]=t.matrix;
    const pts=[[0,0],[120,0],[0,80],[120,80]].map(([x,y])=>[a*x+c*y+e,b*x+d*y+f]);
    assert.equal(Math.min(...pts.map(p=>p[0])),0);assert.equal(Math.max(...pts.map(p=>p[0])),t.width);
    assert.equal(Math.min(...pts.map(p=>p[1])),0);assert.equal(Math.max(...pts.map(p=>p[1])),t.height);
  }
});
test('EXIF is removed before decode and orientation retained exactly once',()=>{
  const b=new Uint8Array(40),v=new DataView(b.buffer);b.set([255,216,255,225,0,34,69,120,105,102,0,0,73,73]);
  v.setUint16(14,42,true);v.setUint32(16,8,true);v.setUint16(20,1,true);v.setUint16(22,0x112,true);v.setUint16(24,3,true);v.setUint32(26,1,true);v.setUint16(30,6,true);b.set([255,217],38);
  const r=O.stripJpegMetadata(b.buffer);assert.equal(r.orientation,6);assert.deepEqual([...new Uint8Array(r.buffer)],[255,216,255,217]);
});
