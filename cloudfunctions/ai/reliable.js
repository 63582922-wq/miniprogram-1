const crypto = require("crypto");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out,k)=>{if(value[k]!==undefined)out[k]=canonical(value[k]);return out;},{});
  return value;
}
function hash(value) { return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function requestKey(kind, owner, requestId) {
  if (typeof requestId!=="string" || !requestId || requestId.length>160) throw new Error("缺少有效请求编号");
  return kind+"-"+hash([owner,requestId]).slice(0,40);
}
async function reserve(collection,id,fingerprint,data) {
  try { await collection.add({data:{...data,_id:id,requestHash:fingerprint}});return {...data,_id:id,requestHash:fingerprint}; }
  catch(error) {
    let row;try { row=(await collection.doc(id).get()).data; }catch(e){throw error;}
    if(!row)throw error;
    if(row.requestHash!==fingerprint)throw new Error("同一请求内容已变化，请先恢复原记录");
    if(row.deleted)throw new Error("该记录已删除，不能重复恢复");
    return row;
  }
}
function assertMedia(path,owner) {
  if(!path)return;
  if(typeof path!=="string" || !path.startsWith("cloud://") || !path.includes("/user/"+owner+"/") || /\.\.|%2f|%2e/i.test(path))throw new Error("图片或录音未上传，或不属于当前用户");
}
async function all(query) {
  const rows=[];let offset=0;
  while(true){const result=await query.skip(offset).limit(100).get();const batch=result.data||[];rows.push(...batch);if(batch.length<100)break;offset+=batch.length;}
  return rows;
}
module.exports={canonical,hash,requestKey,reserve,assertMedia,all};
