const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const cloud = require("wx-server-sdk");
const {hash,requestKey,reserve,all,isOwnedMedia} = require("./reliable");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

/**
 * LOGO 引用的归属收敛。
 *
 * logoFileId 由客户端直接提交，而云存储 fileID 本身就是读取凭据：只要填进
 * 别人的 cloud:// 路径，云端就会用管理员权限为它签发临时链接（readerReport
 * 与 preparePdfSnapshot 都会签），等于代读他人文件。这里只接受落在 owner
 * 自己 user/{openId}/ 目录下的引用。
 *
 * 选择「丢弃 + 告警」而不是抛错：2026-09-15 之前上传的旧 logo 位于
 * logos/<时间戳>.<ext>，没有 user/{openId}/ 前缀，抛错会让这些账号连报告
 * 都发不出去。丢弃不会泄露任何文件，报告只是暂时没有 LOGO。
 */
function ownedLogoFileId(value, owner) {
  if (!value) return "";
  if (typeof value === "string" && isOwnedMedia(value, owner)) return value;
  console.warn("[report] 丢弃不属于该账号的 LOGO 引用");
  return "";
}

/** 分享 token 前缀：用于把可猜测的旧值（report-<时间戳>）识别为无效 */
const SHARE_TOKEN_PREFIX = "sr";

const db = cloud.database();
const _ = db.command;

async function findLatestActiveByOpenId(collectionName, openId) {
  const result = await db.collection(collectionName).where({openId}).get();
  return result.data
    .filter((row) => row && row.deleted !== true)
    .sort((first, second) => {
      const firstTime = Number(first.updatedAt || first.createdAt || 0);
      const secondTime = Number(second.updatedAt || second.createdAt || 0);
      return secondTime - firstTime;
    })[0] || null;
}

async function assertProjectOwner(projectId, openId) {
  if (!projectId) {
    return {
      ok: false,
      message: "缺少项目"
    };
  }
  const doc = await db.collection("projects").doc(projectId).get();
  const project = doc.data;
  if (!project || project.deleted || project.ownerOpenId !== openId) {
    return {
      ok: false,
      message: "无权访问该项目"
    };
  }
  return {
    ok: true,
    project
  };
}

async function assertReportAccess(reportId, openId) {
  const reportDoc = await db.collection("reports").doc(reportId).get();
  const reportRow = reportDoc.data;
  if (!reportRow || reportRow.deleted) {
    return {
      ok: false,
      message: "报告不存在"
    };
  }
  const p = await assertProjectOwner(reportRow.projectId, openId);
  if (!p.ok) {
    return {
      ok: false,
      message: p.message
    };
  }
  return {
    ok: true,
    report: reportRow,
    project: p.project
  };
}

const PDF_SERVICE_BASE_URLS = (
  process.env.PDF_SERVICE_URLS || "https://pdf.haolizhiguan.cn"
).split(",").map((s) => s.trim()).filter(Boolean);
const PDF_API_KEY = process.env.PDF_API_KEY || "";

function getFileNameFromHeaders(headers = {}) {
  const disposition = headers["content-disposition"] || headers["Content-Disposition"] || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (error) {
      return utf8Match[1];
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return (plainMatch && plainMatch[1]) || "";
}

function formatPdfDate(value) {
  if (!value) {
    return "";
  }
  const text = `${value}`;
  if (/^\d{8}$/.test(text)) {
    return text;
  }
  return text.replace(/\D/g, "").slice(0, 8);
}

function buildPdfFileName(reportPayload = {}) {
  const projectName = `${reportPayload.projectName || reportPayload.title || "report"}`.trim();
  const datePart = formatPdfDate(reportPayload.inspectionDate);
  return `${projectName}${datePart || ""}.pdf`;
}

function buildServiceUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, "")}${pathname}`;
}

function isPdfBuffer(fileBuffer) {
  return Boolean(fileBuffer && fileBuffer.length >= 4 && fileBuffer.slice(0, 4).toString("utf8") === "%PDF");
}

function tryParseJsonBuffer(fileBuffer) {
  try {
    return JSON.parse(fileBuffer.toString("utf8"));
  } catch (error) {
    return null;
  }
}

function tryParseByteObjectBuffer(parsed) {
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return null;
  }
  const keys = Object.keys(parsed);
  if (!keys.length || !keys.every((key) => /^\d+$/.test(key))) {
    return null;
  }
  const sortedValues = keys
    .sort((first, second) => Number(first) - Number(second))
    .map((key) => Number(parsed[key]) || 0);
  return Buffer.from(sortedValues);
}

function requestJsonFromUrl(serviceUrl, method = "GET", payload) {
  return new Promise((resolve, reject) => {
    const hasBody = payload !== undefined;
    const requestBody = hasBody ? JSON.stringify(payload) : "";
    const client = serviceUrl.startsWith("https://") ? https : http;
    const request = client.request(serviceUrl, {
      method,
      headers: Object.assign(
        hasBody ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(requestBody)
        } : {},
        PDF_API_KEY ? { "x-api-key": PDF_API_KEY } : {}
      ),
      timeout: 30000
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const fileBuffer = Buffer.concat(chunks);
        if (response.statusCode >= 400) {
          const errorText = fileBuffer.toString("utf8");
          try {
            const parsed = JSON.parse(errorText || "{}");
            reject(new Error(parsed.message || "PDF 服务调用失败"));
          } catch (error) {
            reject(new Error(errorText || "PDF 服务调用失败"));
          }
          return;
        }
        const parsed = tryParseJsonBuffer(fileBuffer);
        if (parsed) {
          resolve(parsed);
          return;
        }
        reject(new Error(`PDF 服务返回内容异常：url=${serviceUrl} status=${response.statusCode || 0}`));
        return;
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("PDF 服务请求超时"));
    });
    request.on("error", (error) => {
      reject(new Error(error.message || "PDF 服务请求失败"));
    });
    if (hasBody) {
      request.write(requestBody);
    }
    request.end();
  });
}

function requestPdfBufferFromUrl(serviceUrl) {
  return new Promise((resolve, reject) => {
    const client = serviceUrl.startsWith("https://") ? https : http;
    const request = client.request(serviceUrl, {
      method: "GET",
      timeout: 300000,
      headers: PDF_API_KEY ? { "x-api-key": PDF_API_KEY } : {}
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const fileBuffer = Buffer.concat(chunks);
        if (response.statusCode >= 400) {
          const errorText = fileBuffer.toString("utf8");
          reject(new Error(errorText || `PDF 下载失败：status=${response.statusCode || 0}`));
          return;
        }
        if (isPdfBuffer(fileBuffer)) {
          resolve({
            fileBuffer,
            fileName: getFileNameFromHeaders(response.headers) || "report.pdf"
          });
          return;
        }
        const parsed = tryParseJsonBuffer(fileBuffer);
        const byteObjectBuffer = tryParseByteObjectBuffer(parsed);
        if (isPdfBuffer(byteObjectBuffer)) {
          resolve({
            fileBuffer: byteObjectBuffer,
            fileName: getFileNameFromHeaders(response.headers) || "report.pdf"
          });
          return;
        }
        reject(new Error(`PDF 下载内容异常：url=${serviceUrl} status=${response.statusCode || 0}`));
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error("PDF 下载超时"));
    });
    request.on("error", (error) => {
      reject(new Error(error.message || "PDF 下载失败"));
    });
    request.end();
  });
}

async function requestJson(payloadPath, method = "GET", payload) {
  let lastError = null;
  for (const baseUrl of PDF_SERVICE_BASE_URLS) {
    try {
      return await requestJsonFromUrl(buildServiceUrl(baseUrl, payloadPath), method, payload);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("PDF 服务请求失败");
}

async function requestPdfBuffer(pathname) {
  let lastError = null;
  for (const baseUrl of PDF_SERVICE_BASE_URLS) {
    try {
      return await requestPdfBufferFromUrl(buildServiceUrl(baseUrl, pathname));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("PDF 服务请求失败");
}

async function uploadPdfBuffer(fileBuffer, fileName) {
  const safeName = `${Date.now()}-${fileName}`.replace(/[\\/:*?"<>|]/g, "-");
  const tempFilePath = path.join(os.tmpdir(), safeName);
  await fs.promises.writeFile(tempFilePath, fileBuffer);
  try {
    const uploaded = await cloud.uploadFile({
      cloudPath: `reports/${safeName}`,
      fileContent: fs.createReadStream(tempFilePath)
    });
    return uploaded.fileID;
  } finally {
    fs.promises.unlink(tempFilePath).catch(() => {});
  }
}

function getInspectorName(user = {}) {
  user = user || {};
  const name = `${user.nickname || ""}`.trim();
  if (!name) return "";
  if (name === "巡查员") return "";
  return name;
}

// Keep the printable report number identical to the online report and report list.
// The number is a display identity, not an authorization credential.
function buildReportNo(report = {}) {
  const raw = report.publishedAt || report.createdAt || report.generatedAt || report.inspectionDate;
  const date = new Date(Number(raw) || raw);
  const valid = !Number.isNaN(date.getTime());
  const ymd = valid
    ? `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
    : "00000000";
  const tail = `${report._id || ""}`.slice(-4).toUpperCase();
  return `CB-${ymd}-${tail || "0000"}`;
}

async function buildReportData(payload, trustedRead = false) {
  const { OPENID } = cloud.getWXContext();
  const inspection = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspection.data || inspection.data.deleted || inspection.data.status === "preparing") {
    return {
      success: false,
      message: "巡查不存在"
    };
  }
  const projectCheck = trustedRead ? {ok:true,project:(await db.collection("projects").doc(inspection.data.projectId).get()).data} : await assertProjectOwner(inspection.data.projectId, OPENID);
  if (!projectCheck.ok) {
    return {
      success: false,
      message: projectCheck.message
    };
  }
  const projectRow = projectCheck.project;
  const items = {data:(await all(db.collection("inspection_items").where({inspectionId:payload.inspectionId}).orderBy("sortOrder","asc")))
    .filter(item=>item.deleted !== true)};
  const user = await findLatestActiveByOpenId("users", inspection.data.inspectorOpenId);
  const appSettings = await findLatestActiveByOpenId(
    "app_settings",
    inspection.data.inspectorOpenId
  ) || {};

  return {
    success: true,
    data: {
      inspectionId: inspection.data._id,
      projectId: projectRow._id,
      title: `${projectRow.name}巡查报告`,
      projectName: projectRow.name,
      projectAddress: projectRow.address || "",
      inspectionDate: inspection.data.inspectionDate,
      inspectionDateText: new Date(inspection.data.inspectionDate).toLocaleDateString("zh-CN"),
      inspectorName: getInspectorName(user),
      inspectorPhone: user ? (user.phone || user.mobile || "") : "",
      companyName: appSettings.companyName || "",
      companyPhone: appSettings.companyPhone || "",
      companyAddress: appSettings.companyAddress || "",
      // appSettings 按被巡查人（inspectorOpenId）读取，不是按当前调用者，
      // 所以归属校验要用同一身份，否则只读读者打开旧报告时会把作者的 LOGO 丢掉。
      logoFileId: ownedLogoFileId(appSettings.logoFileId, inspection.data.inspectorOpenId),
      reportTemplate: appSettings.reportTemplate || "default",
      // Automated analysis summaries repeat the overview counts and are not
      // user-authored report content. Only an explicitly edited inspector
      // summary is included in a newly built report snapshot.
      summary: inspection.data.summarySource === "inspector" ? (inspection.data.aiSummary || "") : "",
      contextNote: inspection.data.note || "",
      photos: inspection.data.photos || [],
      items: items.data
    }
  };
}

async function saveReport(payload) {
  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  if(payload.reportId){
    const access=await assertReportAccess(payload.reportId,OPENID);
    if(!access.ok)return {success:false,message:access.message};
    // Published content is immutable; PDF lifecycle has dedicated actions.
    if(access.report.snapshotVersion)return {success:true,data:access.report};
  }
  const reportStatus = payload.status || (payload.pdfFileId ? "generated" : "draft");

  if (payload.reportId) {
    const access = await assertReportAccess(payload.reportId, OPENID);
    if (!access.ok) {
      return {
        success: false,
        message: access.message
      };
    }
    const updateData = {
      title: payload.title,
      summary: payload.summary,
      contextNote: payload.contextNote || "",
      companyName: payload.companyName || "",
      companyPhone: payload.companyPhone || "",
      companyAddress: payload.companyAddress || "",
      logoFileId: ownedLogoFileId(payload.logoFileId, OPENID),
      reportTemplate: payload.reportTemplate || "default",
      status: reportStatus,
      updatedAt: now,
      updatedBy: OPENID
    };
    if (payload.pdfFileId !== undefined) {
      updateData.pdfFileId = payload.pdfFileId;
    }
    if (payload.pdfTemplateVersion !== undefined) {
      updateData.pdfTemplateVersion = payload.pdfTemplateVersion || "";
    }
    if (payload.pdfTaskId !== undefined) {
      updateData.pdfTaskId = payload.pdfTaskId || "";
    }
    if (payload.pdfTaskStatus !== undefined) {
      updateData.pdfTaskStatus = payload.pdfTaskStatus || "";
    }
    if (payload.pdfErrorMessage !== undefined) {
      updateData.pdfErrorMessage = payload.pdfErrorMessage || "";
    }
    if (reportStatus === "generated") {
      updateData.generatedAt = payload.generatedAt || now;
    }
    await db.collection("reports").doc(payload.reportId).update({
      data: updateData
    });
    const report = await db.collection("reports").doc(payload.reportId).get();
    return {
      success: true,
      data: report.data
    };
  }

  const inspDoc = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspDoc.data || inspDoc.data.deleted) {
    return {
      success: false,
      message: "巡查不存在"
    };
  }
  if (inspDoc.data.projectId !== payload.projectId) {
    return {
      success: false,
      message: "项目与巡查不匹配"
    };
  }
  const createAccess = await assertProjectOwner(payload.projectId, OPENID);
  if (!createAccess.ok) {
    return {
      success: false,
      message: createAccess.message
    };
  }

  const prior=await db.collection("reports").where({inspectionId:payload.inspectionId}).limit(50).get();
  const activePrior=(prior.data || []).find(item=>item.deleted !== true);
  if(activePrior)return {success:true,data:activePrior};
  const data = {
    inspectionId: payload.inspectionId,
    projectId: payload.projectId,
    title: payload.title,
    summary: payload.summary,
    contextNote: payload.contextNote || "",
    companyName: payload.companyName || "",
    companyPhone: payload.companyPhone || "",
    companyAddress: payload.companyAddress || "",
    logoFileId: ownedLogoFileId(payload.logoFileId, OPENID),
    reportTemplate: payload.reportTemplate || "default",
    pdfFileId: payload.pdfFileId || "",
    pdfTemplateVersion: payload.pdfTemplateVersion || "",
    pdfTaskId: payload.pdfTaskId || "",
    pdfTaskStatus: payload.pdfTaskStatus || "",
    pdfErrorMessage: payload.pdfErrorMessage || "",
    coverLogoFileId: "",
    // 创建时就生成分享 token。
    // onShareAppMessage 是同步函数、无法等待网络，所以 token 必须随报告一起就绪。
    // 不用 `report-<时间戳>`：时间戳可被猜测，等于没有保护。
    shareToken: `${SHARE_TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`,
    status: reportStatus,
    generatedAt: reportStatus === "generated" ? (payload.generatedAt || now) : 0,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: OPENID,
    updatedBy: OPENID
  };

  const built=await buildReportData({inspectionId:payload.inspectionId});
  if(!built.success)return built;
  const snapshot=stripInternalFields(built.data);
  const publisher = await findLatestActiveByOpenId("users", OPENID);
  snapshot.publisherName = getInspectorName(publisher);
  snapshot.publisherPhone = publisher ? publisher.phone || publisher.mobile || "" : "";
  delete snapshot.shareToken;
  const id=requestKey("report",OPENID,payload.inspectionId);
  // One publication per inspection; no later client payload can mutate the snapshot.
  let existing=null;try{existing=(await db.collection("reports").doc(id).get()).data;}catch(e){}
  const published=existing || await reserve(db.collection("reports"),id,hash(snapshot),{
    ...data,...snapshot,status:"published",publicationStatus:"published",snapshotVersion:2,snapshot,
    publishedAt:now,shareState:"active",pdfTaskStatus:"idle"
  });
  if(published.deleted)throw new Error("报告已删除");
  await db.collection("inspections").doc(payload.inspectionId).update({data:{reportId:id,updatedAt:now,updatedBy:OPENID}});
  return {success:true,data:{...published.snapshot,...published}};
}

async function fetchReport(reportId) {
  const report = await db.collection("reports").doc(reportId).get();
  return report.data;
}

async function markReportPdfState(reportId, data = {}) {
  const now = Date.now();
  await db.collection("reports").doc(reportId).update({
    data: {
      ...data,
      updatedAt: now
    }
  });
  return fetchReport(reportId);
}

/**
 * 只读读者（业主、施工方）不应该看到的内部字段。
 * 分享链接是给外部人看的，任务号、错误堆栈这类运维信息与业务无关。
 */
const READER_HIDDEN_FIELDS = [
  "pdfTaskId",
  "pdfTaskStatus",
  "pdfErrorMessage",
  "pdfTemplateVersion",
  "createdBy",
  "updatedBy",
  "deleted", "pdfAttempt", "pdfTaskStartedAt"
];

// A published report is a user-facing snapshot, not an archive of AI task
// payloads. Keep only fields that the report reader and legacy PDF renderer
// actually consume; this also prevents future extraction/debug fields from
// silently becoming part of a delivered report.
const REPORT_ITEM_FIELDS = [
  "id", "sourcePhotoId", "sourceIndex", "subIssueIndex", "annotationId",
  "markerNumber", "sortOrder", "description", "suggestion", "severity",
  "responsibleParty", "responsiblePartyName", "category", "area",
  "images", "annotatedImages", "createdAt"
];

function pickFields(source = {}, fields = []) {
  return Object.fromEntries(fields.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
}

// Older immutable report snapshots may contain the annotation ID/number on an
// issue but lack the shape's `numbered` display flag. Restore that flag only
// when the same photo and exact stable annotation ID are explicitly linked.
// This is a read-time compatibility view; it neither guesses by array position
// nor writes back to an already-published snapshot.
function restoreIssueReferencedNumberedShapes(report = {}) {
  const references = new Set((report.items || [])
    .filter(item => item && item.annotationId && Number(item.markerNumber) > 0)
    .map(item => `${item.sourcePhotoId || ""}\u0000${item.annotationId}`));
  if (!references.size) return report;
  return {
    ...report,
    photos: (report.photos || []).map(photo => ({
      ...photo,
      annotations: (photo.annotations || []).map(annotation =>
        (annotation.type === "box" || annotation.type === "ellipse") &&
        references.has(`${photo.id || ""}\u0000${annotation.id}`)
          ? { ...annotation, numbered: true }
          : annotation
      )
    }))
  };
}

function stripInternalFields(report = {}) {
  const safe = Object.assign({}, restoreIssueReferencedNumberedShapes(report));
  ["snapshot","requestHash","inspectorOpenId","voiceFileId","voiceFilePath","voiceStorageFileId","analysis","aiRawResult","payload"].forEach(k=>delete safe[k]);
  safe.items=(report.items||[]).map(item=>pickFields(item,REPORT_ITEM_FIELDS));
  safe.photos=(report.photos||[]).map(photo=>({
    id:photo.id,
    sourceIndex:photo.sourceIndex,
    imagePath:photo.imagePath,
    annotatedImagePath:photo.annotatedImagePath,
    // Voice text is source material for organizing issue rows, not a separate
    // photo caption. Publishing both used to repeat the same description in
    // the report. Only an explicitly authored photo-level caption belongs here.
    caption:photo.caption||"",
    annotations:readerSafeAnnotations(photo.annotations)
  }));
  READER_HIDDEN_FIELDS.forEach((field) => {
    delete safe[field];
  });
  return safe;
}

function readerSafeAnnotations(annotations = []) {
  const supported = new Set(["box", "ellipse", "arrow", "point", "text"]);
  const point = value => {
    if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
    const x=Number(value.x), y=Number(value.y);
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return {x,y};
  };
  if (!Array.isArray(annotations)) return [];
  return annotations.slice(0, 200).flatMap(annotation => {
    if (!annotation || !supported.has(annotation.type)) return [];
    const a=point(annotation.a), b=point(annotation.b);
    if (!a || !b) return [];
    return [{
      id:typeof annotation.id === "string" ? annotation.id.slice(0, 100) : "",
      type:annotation.type,
      a,
      b,
      // Numbered boxes/ellipses are the visual counterpart of issue rows in
      // the reader report. Keep only this explicit boolean from the internal
      // annotation model; other editing metadata remains private.
      ...((annotation.type === "box" || annotation.type === "ellipse") && annotation.numbered === true ? {numbered:true} : {}),
      ...(annotation.type === "text" ? {text:typeof annotation.text === "string" ? annotation.text.slice(0, 120) : ""} : {})
    }];
  });
}

async function readerReport(report){
  // Explicit allowlist: future internal fields must not silently become share data.
  const pick=(source,keys)=>Object.fromEntries(keys.filter(k=>source[k]!==undefined).map(k=>[k,source[k]]));
  const safe=pick(report,["_id","title","projectName","projectAddress","summary","contextNote","inspectorName","inspectorPhone","publisherName","publisherPhone","companyName","companyPhone","companyAddress","logoFileId","inspectionDate","inspectionDateText","publishedAt","createdAt","generatedAt","shareState","snapshotVersion"]);
  // 必须在下面批量 getTempFileURL 之前剔除：否则别人的 fileID 已经被签发过，
  // 后续再清空也来不及。历史快照里可能存有未加 user/{openId}/ 作用域的旧引用。
  safe.logoFileId=ownedLogoFileId(safe.logoFileId, report.createdBy);
  // A transcript is source material for confirmed issue rows, never an
  // implicit photo caption. Legacy records must not re-publish it as a second,
  // unreviewed description or leak raw speech alongside the confirmed issue.
  safe.photos=(report.photos||[]).map(p=>({...pick(p,["id","sourceIndex","imagePath","annotatedImagePath"]),caption:p.caption||"",annotations:readerSafeAnnotations(p.annotations)}));
  safe.items=(report.items||[]).map(i=>pick(i,["id","sourcePhotoId","sourceIndex","subIssueIndex","annotationId","markerNumber","sortOrder","description","suggestion","severity","responsibleParty","responsiblePartyName","category","area","images","annotatedImages","createdAt"]));
  // A temporary image URL failure must not hide the report's readable facts.
  // Resolve shared media independently and return an explicit availability
  // flag, never the underlying cloud file IDs, when some files cannot resolve.
  const fileIds=[safe.logoFileId,...safe.photos.flatMap(p=>[p.imagePath,p.annotatedImagePath]),...safe.items.flatMap(i=>[...(i.images||[]),...(i.annotatedImages||[])])]
    .filter(value=>typeof value==="string"&&value.startsWith("cloud://"));
  const unique=[...new Set(fileIds)],urls={},unavailable=new Set();
  for(let offset=0;offset<unique.length;offset+=50){
    const batch=unique.slice(offset,offset+50);
    try{
      const result=await cloud.getTempFileURL({fileList:batch});
      const returned=new Map((result.fileList||[]).map(file=>[file.fileID,file.tempFileURL]));
      batch.forEach(id=>{const url=returned.get(id);if(url)urls[id]=url;else unavailable.add(id);});
    }catch(_error){batch.forEach(id=>unavailable.add(id));}
  }
  const resolveMedia=value=>{
    if(typeof value!=="string"||!value)return "";
    if(!value.startsWith("cloud://"))return value;
    return urls[value]||"";
  };
  const logoFileId=typeof safe.logoFileId==="string"?safe.logoFileId:"";
  safe.logoUnavailable=Boolean(logoFileId.startsWith("cloud://")&&unavailable.has(logoFileId));
  safe.logoFileId=resolveMedia(logoFileId);
  safe.photos=safe.photos.map(photo=>({...photo,
    imagePath:resolveMedia(photo.imagePath),
    annotatedImagePath:resolveMedia(photo.annotatedImagePath)
  }));
  safe.items=safe.items.map(item=>({...item,
    images:(item.images||[]).map(resolveMedia),
    annotatedImages:(item.annotatedImages||[]).map(resolveMedia)
  }));
  safe.mediaUnavailable=unavailable.size>0;
  return safe;
}

async function detailReport(payload) {
  const { OPENID } = cloud.getWXContext();
  const report = await db.collection("reports").doc(payload.reportId).get();
  if (!report.data || report.data.deleted) {
    return {
      success: false,
      message: "报告不存在"
    };
  }

  // 两种访问方式：
  // 1. 项目所有者本人
  // 2. 持有有效分享 token 的读者（业主、施工方）
  //
  // 报告要转发给不是小程序用户、也不该拿到账号权限的人看。
  // 用不可猜测的 token 做只读访问，比放开 owner 鉴权安全得多。
  const ownerCheck = await assertProjectOwner(report.data.projectId, OPENID);
  const tokenMatched = Boolean(
    payload.shareToken
    && report.data.shareToken
    && report.data.shareState !== "revoked"
    && payload.shareToken === report.data.shareToken
  );

  if (!ownerCheck.ok && !tokenMatched) {
    return {
      success: false,
      message: "无权访问该报告"
    };
  }

  const build = report.data.snapshotVersion ? {success:true,data:report.data.snapshot} : await buildReportData({inspectionId:report.data.inspectionId}, true);
  if (!build.success) {
    return build;
  }

  const merged = {
    ...report.data,
    ...build.data,
    items: build.data.items,
    photos: build.data.photos || [],
    inspectionDate: build.data.inspectionDate,
    inspectionDateText: build.data.inspectionDateText,
    inspectorName: build.data.inspectorName,
    inspectorPhone: build.data.inspectorPhone,
    projectName: build.data.projectName,
    projectAddress: build.data.projectAddress || report.data.projectAddress || "",
    title: report.data.title || build.data.title,
    summary: report.data.summary || build.data.summary,
    contextNote: report.data.contextNote || build.data.contextNote
  };

  const visibleReport = restoreIssueReferencedNumberedShapes(merged);
  return {
    success: true,
    data: Object.assign(
      {},
      ownerCheck.ok ? visibleReport : await readerReport(visibleReport),
      // 告知客户端当前是哪种访问方式：分享进来的读者不应看到生成/删除等操作
      { accessMode: ownerCheck.ok ? "owner" : "shared" }
    )
  };
}

/**
 * 为报告生成（或复用）分享 token。
 *
 * token 一旦生成就复用——已经转发出去的链接不该因为再次分享而失效。
 * 早期的 `report-<时间戳>` 可被猜测，视为无效并重新生成。
 */
async function createShareToken(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertReportAccess(payload.reportId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }

  const existing = access.report.shareState === "revoked" || payload.rotate ? "" : `${access.report.shareToken || ""}`;
  if (existing.startsWith(SHARE_TOKEN_PREFIX) && existing.length >= 24) {
    return {
      success: true,
      data: { shareToken: existing }
    };
  }

  const shareToken = `${SHARE_TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
  // Sharing can be managed from more than one device. Compare-and-set against
  // the row we authorized above so an in-flight create/rotate cannot overwrite
  // a revoke (or another rotation) that completed in the meantime.
  const expected = access.report;
  const conditions = [{_id: payload.reportId}];
  ["shareToken", "shareState"].forEach(field => {
    conditions.push(Object.prototype.hasOwnProperty.call(expected, field)
      ? {[field]: expected[field]}
      : {[field]: _.exists(false)});
  });
  const updated = await db.collection("reports").where(_.and(conditions)).update({
    data: {shareToken, shareState: "active", updatedAt: Date.now()}
  });
  if (!updated.stats || !updated.stats.updated) {
    const latest = await fetchReport(payload.reportId);
    // A competing rotation may have already produced the active link. Return
    // only that current token; never return the stale token we failed to save.
    if (latest && latest.shareState !== "revoked"
      && `${latest.shareToken || ""}`.startsWith(SHARE_TOKEN_PREFIX)
      && `${latest.shareToken || ""}`.length >= 24) {
      return {success: true, data: {shareToken: latest.shareToken}};
    }
    return {success: false, message: "分享状态刚刚发生变化，请重新打开后重试"};
  }

  return {
    success: true,
    data: { shareToken }
  };
}

async function revokeShareToken(payload) {
  const {OPENID}=cloud.getWXContext();
  const access=await assertReportAccess(payload.reportId,OPENID);
  if(!access.ok)return {success:false,message:access.message};
  if (access.report.shareState === "revoked" && !access.report.shareToken) {
    return {success:true,data:{shareToken:"",shareState:"revoked"}};
  }
  const conditions=[{_id:payload.reportId}];
  ["shareToken","shareState"].forEach(field=>{
    conditions.push(Object.prototype.hasOwnProperty.call(access.report,field)
      ? {[field]:access.report[field]}
      : {[field]:_.exists(false)});
  });
  const updated=await db.collection("reports").where(_.and(conditions)).update({data:{shareToken:"",shareState:"revoked",updatedAt:Date.now()}});
  if(!updated.stats||!updated.stats.updated){
    const latest=await fetchReport(payload.reportId);
    if(latest&&latest.shareState==="revoked"&&!latest.shareToken)return {success:true,data:{shareToken:"",shareState:"revoked"}};
    return {success:false,message:"分享状态刚刚发生变化，未执行撤销；请重新打开后重试"};
  }
  return {success:true,data:{shareToken:"",shareState:"revoked"}};
}
async function listReports(payload = {}) {
  const {OPENID}=cloud.getWXContext();
  const projects=(await all(db.collection("projects").where({ownerOpenId:OPENID})))
    .filter(project=>project.deleted !== true && project.status !== "preparing");
  let ids=projects.map(p=>p._id);
  if(payload.projectId){if(!ids.includes(payload.projectId))return {success:false,message:"无权查看该项目报告"};ids=[payload.projectId];}
  const rows=[];
  for(let i=0;i<ids.length;i+=50)rows.push(...(await all(db.collection("reports").where({projectId:_.in(ids.slice(i,i+50))})))
    .filter(report=>report.deleted !== true));
  // Legacy reports have no publishedAt; keep their original publication/creation order.
  rows.sort((a,b)=>(b.publishedAt??b.createdAt??b.generatedAt??0)-(a.publishedAt??a.createdAt??a.generatedAt??0)||String(a._id).localeCompare(String(b._id)));
  const page=Math.max(1,Math.floor(Number(payload.page)||1)),pageSize=Math.min(50,Math.max(1,Math.floor(Number(payload.pageSize)||20)));
  return {success:true,data:{list:rows.slice((page-1)*pageSize,page*pageSize).map(r=>{
    const {_id,title,projectId,publishedAt,createdAt,generatedAt,status,pdfTaskStatus,shareState}=r;
    // 列表只需要摘要，详情仍然读取不可变快照。旧报告没有 snapshot 时保持可用。
    const source = r.snapshot && typeof r.snapshot === "object" ? r.snapshot : r;
    const items = Array.isArray(source.items) ? source.items : [];
    const photos = Array.isArray(source.photos) ? source.photos : [];
    const counts = items.reduce((result, item) => {
      const key = ["critical", "major", "normal"].includes(item && item.severity) ? item.severity : "normal";
      result[key] += 1;
      return result;
    }, {critical:0,major:0,normal:0});
    return {_id,title,projectId,publishedAt,createdAt,generatedAt,status,pdfTaskStatus,shareState,
      photoCount:photos.length,issueCount:items.length,criticalCount:counts.critical,majorCount:counts.major,normalCount:counts.normal};
  }),total:rows.length,page,pageSize,hasMore:page*pageSize<rows.length}};
}

async function removeReport(payload) {
  if (!payload.reportId) {
    return {
      success: false,
      message: "缺少报告ID"
    };
  }

  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  const report = await db.collection("reports").doc(payload.reportId).get();
  if (!report.data || report.data.deleted) {
    return {
      success: true,
      data: true
    };
  }

  const access = await assertProjectOwner(report.data.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }

  await db.collection("reports").doc(payload.reportId).update({
    data: {
      deleted: true,
      updatedAt: now,
      updatedBy: OPENID
    }
  });

  if (report.data.inspectionId) {
    try {
      const inspection = await db.collection("inspections").doc(report.data.inspectionId).get();
      if (inspection.data && inspection.data.reportId === payload.reportId) {
        await db.collection("inspections").doc(report.data.inspectionId).update({
          data: {
            reportId: "",
            updatedAt: now,
            updatedBy: OPENID
          }
        });
      }
    } catch (error) {
    }
  }

  return {
    success: true,
    data: true
  };
}

/**
 * 已移除 generatePdf 同步出图通道。
 *
 * 原因是它同时存在两个问题：
 * 1. 没有任何鉴权——任意登录用户都能调用；
 * 2. 把客户端传入的 payload 直接当作 URL path 交给 PDF 服务，
 *    而请求头里带着服务端的 PDF_API_KEY。
 *
 * 两者相加等于：任何登录用户都能借我们的密钥驱动 Puppeteer，
 * 并把结果写进 reports/ 云存储目录。
 *
 * 现在出图只走 createPdfTask → getPdfTaskStatus，两步都有归属校验。
 */

async function preparePdfSnapshot(snapshot, ownerOpenId) {
  const payload=JSON.parse(JSON.stringify(snapshot));
  // 与 readerReport 同理：先剔除不属于作者的 LOGO，再进入批量签发。
  payload.logoFileId=ownedLogoFileId(payload.logoFileId, ownerOpenId);
  const ids=[payload.logoFileId,...(payload.photos||[]).flatMap(p=>[p.imagePath,p.annotatedImagePath]),...(payload.items||[]).flatMap(p=>[...(p.images||[]),...(p.annotatedImages||[])])].filter(p=>typeof p==="string"&&p.startsWith("cloud://"));
  const urls={};const unique=[...new Set(ids)];
  for(let i=0;i<unique.length;i+=50){
    const result=await cloud.getTempFileURL({fileList:unique.slice(i,i+50)});
    (result.fileList||[]).forEach(f=>{if(f.tempFileURL)urls[f.fileID]=f.tempFileURL;});
  }
  const url=p=>{if(p&&p.startsWith("cloud://")&&!urls[p])throw new Error("报告图片暂不可用，请重试");return urls[p]||p||"";};
  payload.logoUrl=url(payload.logoFileId);
  payload.inspectionDate=payload.inspectionDateText||payload.inspectionDate;
  payload.photos=(payload.photos||[]).map(p=>({...p,imagePath:url(p.imagePath),annotatedImagePath:url(p.annotatedImagePath)}));
  payload.items=(payload.items||[]).map(p=>({...p,images:(p.images||[]).map(url),annotatedImages:(p.annotatedImages||[]).map(url),
    severityText:({normal:"一般",major:"较重",critical:"严重"})[p.severity]||"一般",
    responsiblePartyText:({pending:"待确认",constructor:"施工方",supplier:"供应方",client:"业主"})[p.responsibleParty]||"待确认"}));
  return payload;
}
async function createPdfTask(payload) {
  const {OPENID}=cloud.getWXContext(),access=await assertReportAccess(payload.reportId,OPENID);
  if(!access.ok)return {success:false,message:access.message};
  const previous=access.report;
  if(previous.pdfTaskId&&["starting","queued","running"].includes(previous.pdfTaskStatus)){
    return {success:true,data:{taskId:previous.pdfTaskId,taskStatus:previous.pdfTaskStatus,report:previous}};
  }
  const attempt=(previous.pdfAttempt||0)+1,taskId="pdf-"+hash([payload.reportId,"precision-A-v2",attempt]).slice(0,40),now=Date.now();
  const acquired=await db.collection("reports").where(_.and([{_id:payload.reportId},
    previous.pdfAttempt===undefined?{pdfAttempt:_.exists(false)}:{pdfAttempt:previous.pdfAttempt}
  ])).update({data:{pdfAttempt:attempt,pdfTaskId:taskId,pdfTaskStatus:"starting",status:"pdf_generating",pdfTaskStartedAt:now,pdfErrorMessage:"",updatedAt:now}});
  if(!acquired.stats.updated){const row=await fetchReport(payload.reportId);return {success:true,data:{taskId:row.pdfTaskId,taskStatus:row.pdfTaskStatus,report:row}};}
  let reportPayload;
  try{
    const snapshot=previous.snapshotVersion?previous.snapshot:(await buildReportData({inspectionId:previous.inspectionId})).data;
    if(!snapshot)throw new Error("报告数据不完整");
    reportPayload={...await preparePdfSnapshot(snapshot, previous.createdBy || OPENID),reportNo:buildReportNo({...snapshot,...previous}),jobId:taskId};
  }catch(e){
    await markReportPdfState(payload.reportId,{status:"pdf_failed",pdfTaskStatus:"failed",pdfErrorMessage:e.message});
    throw e;
  }
  try{
    const response=await requestJson("/api/report-pdf/tasks","POST",reportPayload);
    if(!response?.success||response.data?.taskId!==taskId)throw new Error(response?.message||"PDF服务版本不匹配，请先部署兼容服务");
    const report=await markReportPdfState(payload.reportId,{pdfTaskStatus:response.data.status||"queued"});
    return {success:true,data:{taskId,taskStatus:report.pdfTaskStatus,report}};
  }catch(e){
    // The service may have accepted the POST before its response was lost.
    // Keep the known job ID; reading it settles the outcome without creating another render.
    const report=await markReportPdfState(payload.reportId,{pdfErrorMessage:"任务响应尚未确认，正在查询同一任务"});
    return {success:true,data:{taskId,taskStatus:"starting",report}};
  }
}

async function getPdfTaskStatus(payload) {
  if (!payload.reportId || !payload.taskId) {
    return {
      success: false,
      message: "缺少报告ID或任务ID"
    };
  }
  const { OPENID } = cloud.getWXContext();
  const access = await assertReportAccess(payload.reportId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  if(access.report.pdfTaskId!==payload.taskId)throw new Error("PDF任务与报告不匹配");
  if(access.report.pdfTaskStatus==="success" && access.report.pdfFileId)return {success:true,data:{taskStatus:"success",report:access.report}};
  if(Date.now()-(access.report.pdfTaskStartedAt||access.report.updatedAt)>10*60*1000 && ["starting","queued","running"].includes(access.report.pdfTaskStatus)){
    const report=await markReportPdfState(payload.reportId,{status:"pdf_failed",pdfTaskStatus:"failed",pdfErrorMessage:"PDF任务超时，请按原报告重试；在线阅读不受影响"});
    return {success:true,data:{taskStatus:"failed",report,errorMessage:report.pdfErrorMessage}};
  }
  let response;
  try{response=await requestJson("/api/report-pdf/tasks/"+payload.taskId,"GET");}
  catch(e){
    if(Date.now()-(access.report.pdfTaskStartedAt||0)<30000)return {success:true,data:{taskStatus:access.report.pdfTaskStatus||"starting",report:access.report}};
    const report=await markReportPdfState(payload.reportId,{status:"pdf_failed",pdfTaskStatus:"failed",pdfErrorMessage:"PDF服务不可用或任务已丢失，请重新生成；在线报告不受影响"});
    return {success:true,data:{taskStatus:"failed",report,errorMessage:report.pdfErrorMessage}};
  }
  if (!response || !response.success || !response.data) {
    throw new Error(response && response.message ? response.message : "获取 PDF 任务状态失败");
  }
  const task = response.data;
  if (task.status === "success") {
    const currentReport = await fetchReport(payload.reportId);
    if (currentReport && currentReport.pdfFileId && currentReport.status === "generated") {
      return {
        success: true,
        data: {
          taskStatus: "success",
          report: currentReport
        }
      };
    }
    const fileResult = await requestPdfBuffer(`/api/report-pdf/tasks/${payload.taskId}/download`);
    const pdfFileId = await uploadPdfBuffer(
      fileResult.fileBuffer,
      fileResult.fileName || buildPdfFileName(currentReport || {})
    );
    const report = await markReportPdfState(payload.reportId, {
      status: "generated",
      pdfFileId,
      pdfTemplateVersion: payload.pdfTemplateVersion || currentReport.pdfTemplateVersion || "",
      pdfTaskId: payload.taskId,
      pdfTaskStatus: "success",
      pdfErrorMessage: "",
      generatedAt: Date.now()
    });
    return {
      success: true,
      data: {
        taskStatus: "success",
        report
      }
    };
  }
  if (task.status === "failed") {
    const report = await markReportPdfState(payload.reportId, {
      status: "pdf_failed",
      pdfTaskId: payload.taskId,
      pdfTaskStatus: "failed",
      pdfErrorMessage: task.errorMessage || "PDF 生成失败"
    });
    return {
      success: true,
      data: {
        taskStatus: "failed",
        report,
        errorMessage: task.errorMessage || "PDF 生成失败"
      }
    };
  }
  const report = await markReportPdfState(payload.reportId, {
    status: "pdf_generating",
    pdfTaskId: payload.taskId,
    pdfTaskStatus: task.status || "queued"
  });
  return {
    success: true,
    data: {
      taskStatus: task.status || "queued",
      report
    }
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  try {
    switch (action) {
      case "build":
        return await buildReportData(payload);
      case "save":
        return await saveReport(payload);
      case "detail":
        return await detailReport(payload);
      case "revokeShareToken": return await revokeShareToken(payload);
      case "createShareToken":
        return await createShareToken(payload);
      case "list":
        return await listReports(payload);
      case "remove":
        return await removeReport(payload);
      default:
        return {
          success: false,
          message: "未知操作"
        };
    }
  } catch (error) {
    console.error("[report] action failed", {
      action,
      message: error && error.message,
      stack: error && error.stack
    });
    return {
      success: false,
      message: (error && error.message) || "报告服务异常，请稍后重试"
    };
  }
};
