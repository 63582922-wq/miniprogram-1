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
/**
 * 所有客户端上传都落在 <folder>/user/{openId}/<file>（见 miniprogram/services/cloud.js）。
 * 云存储 fileID 本身就是读取凭据，而这些函数会以管理员权限为它签发临时链接，
 * 所以归属判断必须是「逐段精确比对」。
 *
 * 旧实现用 path.includes("/user/"+owner+"/")，对以下形式都不设防：
 * 前缀伪造（.../user/{owner}_evil/...）、多加层级、相似 openId。
 * 这里改为解析出 cloud:// 之后的路径并要求恰好四段。
 */
const MEDIA_FOLDERS = new Set([
  "inspection-originals",
  "inspection-images",
  "inspection-annotated-images",
  "inspection-audio",
  "speech-input",
  "logos",
  "reports"
]);
function cloudPathOf(fileID) {
  const matched = /^cloud:\/\/[^/]+\/(.+)$/.exec(`${fileID || ""}`);
  return matched ? matched[1] : "";
}
function isOwnedMedia(path, owner) {
  const ownerText = `${owner || ""}`;
  if (typeof path !== "string" || !path || !ownerText) return false;
  if (!path.startsWith("cloud://")) return false;
  if (/\.\.|%2f|%2e|%5c/i.test(path)) return false;
  const parts = cloudPathOf(path).split("/");
  return parts.length === 4
    && MEDIA_FOLDERS.has(parts[0])
    && parts[1] === "user"
    && parts[2] === ownerText
    && Boolean(parts[3])
    && parts[3] !== "."
    && parts[3] !== "..";
}
function assertMedia(path,owner) {
  if(!path)return;
  if(!isOwnedMedia(path,owner))throw new Error("图片或录音未上传，或不属于当前用户");
}
async function all(query) {
  const rows=[];let offset=0;
  while(true){const result=await query.skip(offset).limit(100).get();const batch=result.data||[];rows.push(...batch);if(batch.length<100)break;offset+=batch.length;}
  return rows;
}
module.exports={canonical,hash,requestKey,reserve,assertMedia,isOwnedMedia,MEDIA_FOLDERS,cloudPathOf,all};
