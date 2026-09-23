const cloud = require("wx-server-sdk");
const {hash,requestKey,reserve,assertMedia,all} = require("./reliable");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

async function assertProjectOwner(projectId, openId) {
  if (!projectId) {
    return {
      ok: false,
      message: "缺少项目"
    };
  }
  const doc = await db.collection("projects").doc(projectId).get();
  const project = doc.data;
  if (!project || project.deleted) {
    return {
      ok: false,
      message: "项目不存在或已被删除"
    };
  }
  if (project.ownerOpenId !== openId) {
    return {
      ok: false,
      message: "无权操作该项目"
    };
  }
  return {
    ok: true,
    project
  };
}

function isCloudFileId(value) {
  return typeof value === "string" && value.startsWith("cloud://");
}

function normalizeVoiceFields(item = {}, sourceDraft = {}) {
  const rawVoiceFileId = item.voiceFileId || sourceDraft.voiceFileId || "";
  const voiceStorageFileId = item.voiceStorageFileId || sourceDraft.voiceStorageFileId || (isCloudFileId(rawVoiceFileId) ? rawVoiceFileId : "");
  const voiceFilePath = item.voiceFilePath || sourceDraft.voiceFilePath || (!isCloudFileId(rawVoiceFileId) ? rawVoiceFileId : "");

  return {
    voiceStorageFileId,
    voiceFilePath,
    voiceFileId: voiceStorageFileId
  };
}

async function listInspections(payload={}) {
  const {OPENID}=cloud.getWXContext(),projects=await all(db.collection("projects").where({ownerOpenId:OPENID,deleted:false}));
  const map=new Map(projects.map(p=>[p._id,p.name]));
  if(payload.projectId&&!map.has(payload.projectId))return {success:false,message:"无权查看该项目"};
  const ids=payload.projectId?[payload.projectId]:[...map.keys()],rows=[];
  for(let i=0;i<ids.length;i+=50)rows.push(...await all(db.collection("inspections").where({deleted:false,projectId:_.in(ids.slice(i,i+50))})));
  const page=Math.max(1,Math.floor(Number(payload.page)||1));
  const pageSize=Math.min(50,Math.max(1,Math.floor(Number(payload.pageSize)||20)));
  const matching=rows.filter(i=>i.status!=="preparing").sort((a,b)=>b.createdAt-a.createdAt);
  if (!payload.page) return {success:true,data:{list:matching.map(i=>({...i,projectName:map.get(i.projectId)})),total:matching.length,hasMore:false}};
  const list=matching.slice((page-1)*pageSize,page*pageSize).map(i=>({...i,projectName:map.get(i.projectId)}));
  return {success:true,data:{list,total:matching.length,page,pageSize,hasMore:page*pageSize<matching.length}};
}

async function confirmInspection(payload = {}) {
  const { OPENID } = cloud.getWXContext();
  if(!payload.form || !Array.isArray(payload.items))throw new Error("记录数据不完整");
  const access=await assertProjectOwner(payload.form.projectId,OPENID);
  if(!access.ok)return {success:false,message:access.message};
  const photos=payload.form.issueDrafts || [];
  if(!photos.length || photos.length>20)throw new Error("巡查需要1至20张照片");
  const photoMap=new Map();
  photos.forEach((p,i)=>{
    const id=p.id || "legacy-"+i;
    if(photoMap.has(id))throw new Error("照片编号重复");
    [p.imagePath,p.sourceOriginalImagePath,p.annotatedImagePath,p.voiceStorageFileId||p.voiceFileId].forEach(f=>assertMedia(f,OPENID));
    if(!p.imagePath)throw new Error("照片缺失");
    photoMap.set(id,{...p,id,sourceIndex:i});
  });
  const rows=payload.items.map((item,index)=>{
    const photo=photoMap.get(item.sourcePhotoId || photos[item.sourceIndex]?.id || "legacy-"+item.sourceIndex);
    if(!photo)throw new Error("问题与来源照片不匹配");
    if(typeof item.description!=="string" || !item.description.trim())throw new Error("问题描述不能为空");
    return {id:item.id || "legacy-issue-"+index,sourcePhotoId:photo.id,sourceIndex:photo.sourceIndex,subIssueIndex:0,
      area:item.area||"",category:item.category||"",severity:["normal","major","critical"].includes(item.severity)?item.severity:"normal",
      responsibleParty:["pending","constructor","supplier","client"].includes(item.responsibleParty)?item.responsibleParty:"pending",
      description:item.description,suggestion:item.suggestion||"",images:[photo.imagePath],annotatedImages:[photo.annotatedImagePath||photo.imagePath],
      annotations:photo.annotations||[],voiceStorageFileId:photo.voiceStorageFileId||"",voiceFileId:photo.voiceStorageFileId||"",voiceText:photo.voiceText||"",sortOrder:index};
  });
  if(new Set(rows.map(r=>r.id)).size!==rows.length)throw new Error("问题编号重复");
  const counts={};rows.forEach(r=>{counts[r.sourcePhotoId]=(counts[r.sourcePhotoId]||0)+1;r.subIssueIndex=counts[r.sourcePhotoId];});
  const evidence=[...photoMap.values()].map(p=>({id:p.id,sourceIndex:p.sourceIndex,imagePath:p.imagePath,sourceOriginalImagePath:p.sourceOriginalImagePath||p.imagePath,annotatedImagePath:p.annotatedImagePath||"",annotations:p.annotations||[],annotationStage:p.annotationStage||null,voiceText:p.voiceText||"",voiceStorageFileId:p.voiceStorageFileId||""}));
  const canonical={projectId:payload.form.projectId,title:payload.form.title||"",note:payload.form.note||"",aiSummary:payload.form.aiSummary||"",photos:evidence,items:rows};
  // Legacy clients are deduplicated by confirmed content; v2 sends a stable explicit request.
  const req=payload.requestId || "legacy-"+hash(canonical), id=requestKey("inspection",OPENID,req);
  const collection=db.collection("inspections"), now=Date.now();
  const inspection=await reserve(collection,id,hash(canonical),{projectId:canonical.projectId,title:canonical.title||"现场巡查",
    inspectionDate:now,inspectorOpenId:OPENID,status:"preparing",schemaVersion:2,issueCount:rows.length,
    photos:evidence,reportId:"",note:canonical.note,aiSummary:canonical.aiSummary,deleted:false,createdAt:now,updatedAt:now,createdBy:OPENID,updatedBy:OPENID});
  if(inspection.status==="submitted")return {success:true,data:{inspectionId:id}};
  const originals=new Map((payload.originalItems||[]).map(p=>[p.id,p]));
  // Fixed child IDs make interrupted retries safe. Readers gate on parent.status.
  for(const item of rows){
    await db.collection("inspection_items").doc(requestKey("item",id,item.id)).set({data:{...item,inspectionId:id,projectId:canonical.projectId,
      aiRawResult:originals.get(item.id)||null,confirmStatus:"confirmed",deleted:false,createdAt:inspection.createdAt,updatedAt:inspection.createdAt,createdBy:OPENID,updatedBy:OPENID}});
  }
  await db.collection("projects").doc(canonical.projectId).update({data:{lastInspectionAt:inspection.createdAt,updatedAt:now,updatedBy:OPENID}});
  await collection.doc(id).update({data:{status:"submitted",updatedAt:now}});
  return {success:true,data:{inspectionId:id}};
}

async function detailInspection(payload) {
  const { OPENID } = cloud.getWXContext();
  const inspection = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspection.data || inspection.data.deleted || inspection.data.status === "preparing") {
    return {
      success: false,
      message: "巡查不存在或已被删除"
    };
  }
  const access = await assertProjectOwner(inspection.data.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const items = {data:await all(db.collection("inspection_items").where({inspectionId:payload.inspectionId,deleted:false}).orderBy("sortOrder","asc"))};
  const report = await db.collection("reports").where({
    inspectionId: payload.inspectionId,
    deleted: false
  }).get();
  const project = await db.collection("projects").doc(inspection.data.projectId).get();

  return {
    success: true,
    data: {
      inspection: {
        ...inspection.data,
        projectName: project.data ? project.data.name : ""
      },
      items: items.data,
      report: report.data[0] || null
    }
  };
}

async function refreshProjectLastInspection(projectId, openId) {
  if (!projectId) {
    return;
  }
  const latestInspection = await db.collection("inspections").where({
    projectId,
    deleted: false
  }).orderBy("createdAt", "desc").limit(1).get();
  const lastInspectionAt = latestInspection.data && latestInspection.data[0]
    ? latestInspection.data[0].createdAt
    : "";

  await db.collection("projects").doc(projectId).update({
    data: {
      lastInspectionAt,
      updatedAt: Date.now(),
      updatedBy: openId
    }
  });
}

async function removeInspection(payload) {
  if (!payload.inspectionId) {
    return {
      success: false,
      message: "缺少巡查ID"
    };
  }

  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  const inspection = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspection.data || inspection.data.deleted) {
    return {
      success: true,
      data: true
    };
  }

  const access = await assertProjectOwner(inspection.data.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }

  await db.collection("inspections").doc(payload.inspectionId).update({
    data: {
      deleted: true,
      updatedAt: now,
      updatedBy: OPENID
    }
  });

  const [items, reports] = await Promise.all([
    db.collection("inspection_items").where({
      inspectionId: payload.inspectionId,
      deleted: false
    }).get(),
    db.collection("reports").where({
      inspectionId: payload.inspectionId,
      deleted: false
    }).get()
  ]);

  await Promise.all((items.data || []).map((item) => db.collection("inspection_items").doc(item._id).update({
    data: {
      deleted: true,
      updatedAt: now,
      updatedBy: OPENID
    }
  })));

  await Promise.all((reports.data || []).map((item) => db.collection("reports").doc(item._id).update({
    data: {
      deleted: true,
      updatedAt: now,
      updatedBy: OPENID
    }
  })));

  await refreshProjectLastInspection(inspection.data.projectId, OPENID);

  return {
    success: true,
    data: true
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "list":
      return listInspections(payload);
    case "create":
      return confirmInspection({
        form: payload,
        items: []
      });
    case "confirm":
      return confirmInspection(payload);
    case "detail":
      return detailInspection(payload);
    case "remove":
      return removeInspection(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
