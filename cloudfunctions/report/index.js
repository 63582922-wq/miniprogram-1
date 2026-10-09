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
 * 别人的 cloud:// 路径，云端就会用管理员权限为它签发临时链接（readerReport 会签），等于代读他人文件。这里只接受落在 owner
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
      // 告知客户端这是哪种访问方式。detail 一直带这个字段，build 却没带，
      // 于是「历史记录 → 整理并生成报告」打开后 isOwner 恒为 false，
      // 页面显示成「你正在查看他人分享的巡查报告」，也没有发布/转发入口——
      // 承诺的「生成报告」什么也没生成。
      accessMode: trustedRead ? "shared" : "owner",
      inspectionId: inspection.data._id,
      projectId: projectRow._id,
      title: `${projectRow.name}巡查报告`,
      projectName: projectRow.name,
      projectAddress: projectRow.address || "",
      // 甲方联系方式是项目自带的对外信息：报告会发给施工方与业主，
      // 让他们知道这活是谁的。此前只在项目详情页显示，进不了报告。
      clientName: projectRow.clientName || "",
      clientPhone: projectRow.clientPhone || "",
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
    // Published content is immutable; a later payload can never rewrite the snapshot.
    if(access.report.snapshotVersion)return {success:true,data:access.report};
  }
  const reportStatus = payload.status || "draft";

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
  let published;
  if(existing && existing.deleted){
    // 用户删过这份报告，之后又在同一次记录上重新生成——这是明确要求把它拿回来。
    //
    // 原先这里直接抛「报告已删除」，用户就再没有出路：报告的 _id 由
    // openid + inspectionId 决定，是确定性的，所以每次重新生成都会命中
    // 同一份已删报告，永远失败。删掉报告等于这次记录再也发不出去。
    //
    // 复活时必须**换掉分享 token**：删除本身就撤回了此前发出去的链接
    // （读取处会挡 deleted，而链接指的还是那个 token），
    // 沿用旧 token 会让那些已经作废的链接悄悄恢复访问。
    const revivedToken=`${SHARE_TOKEN_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
    await db.collection("reports").doc(id).update({data:{
      ...data,...snapshot,status:"published",publicationStatus:"published",snapshotVersion:2,snapshot,
      publishedAt:now,shareState:"active",shareToken:revivedToken,
      deleted:false,updatedAt:now,updatedBy:OPENID
    }});
    published={...existing,...data,...snapshot,status:"published",publicationStatus:"published",
      snapshotVersion:2,snapshot,publishedAt:now,shareState:"active",shareToken:revivedToken,
      deleted:false,updatedAt:now,updatedBy:OPENID};
  }else{
    published=existing || await reserve(db.collection("reports"),id,hash(snapshot),{
      ...data,...snapshot,status:"published",publicationStatus:"published",snapshotVersion:2,snapshot,
      publishedAt:now,shareState:"active"
    });
    if(published.deleted)throw new Error("报告已删除");
  }
  await db.collection("inspections").doc(payload.inspectionId).update({data:{reportId:id,updatedAt:now,updatedBy:OPENID}});
  return {success:true,data:{...published.snapshot,...published}};
}

async function fetchReport(reportId) {
  const report = await db.collection("reports").doc(reportId).get();
  return report.data;
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
  const safe=pick(report,["_id","title","projectName","projectAddress","clientName","clientPhone","summary","contextNote","inspectorName","inspectorPhone","publisherName","publisherPhone","companyName","companyPhone","companyAddress","logoFileId","inspectionDate","inspectionDateText","publishedAt","createdAt","generatedAt","shareState","snapshotVersion"]);
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
