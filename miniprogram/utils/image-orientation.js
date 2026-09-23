// Strip JPEG APP1 metadata before decoding, then apply its EXIF orientation exactly once.
// This prevents platform-dependent auto-orientation from being applied twice.
function stripJpegMetadata(buffer) {
  const bytes=new Uint8Array(buffer);
  if(bytes[0]!==255||bytes[1]!==216)return {jpeg:false,buffer,orientation:1};
  const parts=[bytes.slice(0,2)];let at=2,orientation=1;
  while(at+4<=bytes.length){
    if(bytes[at]!==255)break;
    const marker=bytes[at+1];
    if(marker===218||marker===217)break;
    const length=(bytes[at+2]<<8)|bytes[at+3],end=at+2+length;
    if(length<2||end>bytes.length)break;
    if(marker===225){
      if(String.fromCharCode(...bytes.slice(at+4,at+10))==='Exif\0\0'){
        try{
          const base=at+10,v=new DataView(buffer),little=v.getUint16(base,false)===0x4949;
          const ifd=base+v.getUint32(base+4,little),count=v.getUint16(ifd,little);
          for(let i=0;i<count;i++){const p=ifd+2+i*12;if(p+12>end)break;
            if(v.getUint16(p,little)===0x112 && v.getUint16(p+2,little)===3 && v.getUint32(p+4,little)===1){
              const n=v.getUint16(p+8,little);if(n>=1&&n<=8)orientation=n;
            }
          }
        }catch(e){throw new Error('照片方向信息损坏，请重新选择或拍摄照片');}
      }
    }else parts.push(bytes.slice(at,end));
    at=end;
  }
  parts.push(bytes.slice(at));const merged=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;
  parts.forEach(p=>{merged.set(p,offset);offset+=p.length;});return {jpeg:true,buffer:merged.buffer,orientation};
}
function orientationTransform(n,w,h){
  const matrices={1:[1,0,0,1,0,0],2:[-1,0,0,1,w,0],3:[-1,0,0,-1,w,h],4:[1,0,0,-1,0,h],5:[0,1,1,0,0,0],6:[0,1,-1,0,h,0],7:[0,-1,-1,0,h,w],8:[0,-1,1,0,0,w]};
  return {matrix:matrices[n]||matrices[1],width:n>=5?h:w,height:n>=5?w:h};
}
module.exports={stripJpegMetadata,orientationTransform};
