const cloud = require("wx-server-sdk");
const {hash,requestKey,reserve,all} = require("./reliable");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

async function safeGetDoc(collectionName, docId) {
  if (!docId) {
    return null;
  }
  try {
    const result = await db.collection(collectionName).doc(docId).get();
    return result.data || null;
  } catch (error) {
    return null;
  }
}

async function safeGetList(queryRef) {
  try {
    return (await all(queryRef)).filter(row=>row.status!=="preparing" && row.deleted !== true);
  } catch (error) {
    throw error;
  }
}

async function assertProjectOwner(projectId, openId) {
  if (!projectId) {
    return {
      ok: false,
      message: "缺少项目ID"
    };
  }
  const project = await safeGetDoc("projects", projectId);
  if (!project || project.deleted) {
    return {
      ok: false,
      message: "项目不存在或已被删除"
    };
  }
  if (project.ownerOpenId !== openId) {
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

async function createProject(payload) {
  if(!payload.name || !payload.name.trim())throw new Error("请填写项目名称");
  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  const data = {
    name: payload.name,
    address: payload.address || "",
    clientName: payload.clientName || "",
    clientPhone: payload.clientPhone || "",
    description: payload.description || "",
    ownerOpenId: OPENID,
    teamId: "",
    status: payload.status || "active",
    deleted: false,
    lastInspectionAt: "",
    createdAt: now,
    updatedAt: now,
    createdBy: OPENID,
    updatedBy: OPENID
  };

  const requestId=payload.requestId || "legacy-"+hash({...payload,requestId:undefined});
  const result=await reserve(db.collection("projects"),requestKey("project",OPENID,requestId),hash({...payload,requestId:undefined}),data);

  return {
    success: true,
    data: {
      ...data,
      _id: result._id
    }
  };
}

async function updateProject(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertProjectOwner(payload.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  await db.collection("projects").doc(payload.projectId).update({
    data: {
      name: payload.name,
      address: payload.address,
      clientName: payload.clientName || "",
      clientPhone: payload.clientPhone || "",
      description: payload.description || "",
      status: payload.status || "active",
      updatedAt: Date.now(),
      updatedBy: OPENID
    }
  });

  return detailProject({
    projectId: payload.projectId
  });
}

async function listProjects(payload) {
  const { OPENID } = cloud.getWXContext();
  // 旧项目可能没有 deleted 字段；只排除明确删除或尚未完成的记录，
  // 避免新版首页把历史项目误显示成“暂无项目”。
  const result = {data:(await all(db.collection("projects").where({ownerOpenId:OPENID}).orderBy("updatedAt","desc")))
    .filter(item=>item.deleted !== true && item.status !== "preparing")};

  const matching = (result.data || []).filter((item) => {
    if (!payload.keyword) {
      return true;
    }

    return `${item.name}${item.address}`.includes(payload.keyword);
  });

  const page=Math.max(1,Math.floor(Number(payload.page)||1)),pageSize=Math.min(50,Math.max(1,Math.floor(Number(payload.pageSize)||20)));
  const list=matching.slice((page-1)*pageSize,page*pageSize);
  const projectIds = list.map((item) => item._id);
  let inspectionCountMap = {};
  let issueCountMap = {};
  let reportCountMap = {};

  if (projectIds.length) {
    const inspections = {data:(await all(db.collection("inspections").where({projectId:_.in(projectIds)})))
      .filter(item=>item.deleted !== true)};
    const inspectionItems = {data:(await all(db.collection("inspection_items").where({projectId:_.in(projectIds)})))
      .filter(item=>item.deleted !== true)};
    const reports = {data:(await all(db.collection("reports").where({projectId:_.in(projectIds)})))
      .filter(item=>item.deleted !== true)};

    inspectionCountMap = (inspections.data || []).filter(i=>i.status!=="preparing").reduce((accumulator, item) => {
      accumulator[item.projectId] = (accumulator[item.projectId] || 0) + 1;
      return accumulator;
    }, {});

    const completeIds=new Set(inspections.data.filter(i=>i.status!=="preparing").map(i=>i._id));
    issueCountMap = (inspectionItems.data || []).filter(i=>completeIds.has(i.inspectionId)).reduce((accumulator, item) => {
      accumulator[item.projectId] = (accumulator[item.projectId] || 0) + 1;
      return accumulator;
    }, {});

    reportCountMap = (reports.data || []).reduce((accumulator, item) => {
      accumulator[item.projectId] = (accumulator[item.projectId] || 0) + 1;
      return accumulator;
    }, {});
  }

  const normalizedList = list.map((item) => ({
    ...item,
    inspectionsCount: inspectionCountMap[item._id] || 0,
    issuesCount: issueCountMap[item._id] || 0,
    reportsCount: reportCountMap[item._id] || 0
  }));

  return {
    success: true,
    data: {
      list: normalizedList,
      total: matching.length, page, pageSize, hasMore:page*pageSize<matching.length
    }
  };
}

async function detailProject(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertProjectOwner(payload.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const project = access.project;

  const [inspections, reports, memos, chatAnalysis] = await Promise.all([
    safeGetList(db.collection("inspections").where({projectId: payload.projectId}).orderBy("createdAt", "desc")),
    safeGetList(db.collection("reports").where({projectId: payload.projectId}).orderBy("createdAt", "desc")),
    safeGetList(db.collection("memos").where({projectId: payload.projectId}).orderBy("createdAt", "desc")),
    safeGetList(db.collection("chat_analysis").where({projectId: payload.projectId}).orderBy("createdAt", "desc"))
  ]);

  return {
    success: true,
    data: {
      project,
      inspections,
      reports,
      memos,
      chatAnalysis
    }
  };
}

async function galleryProject(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertProjectOwner(payload.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const project = access.project;

  const [inspections, items] = await Promise.all([
    safeGetList(db.collection("inspections").where({projectId: payload.projectId}).orderBy("createdAt", "desc")),
    safeGetList(db.collection("inspection_items").where({projectId: payload.projectId}).orderBy("createdAt", "desc"))
  ]);

  const inspectionMap = (inspections || []).reduce((accumulator, item) => {
    accumulator[item._id] = item;
    return accumulator;
  }, {});

  const photos = [];
  const seenPhotoIds = new Set();

  // 新版巡查把“照片本身”保存到 inspections.photos，因此即使一张照片没有
  // 生成问题，也必须出现在项目相册里。问题子项只描述照片上的问题，不能反
  // 过来决定照片是否存在。
  (inspections || []).forEach((inspection) => {
    const inspectionItems = (items || []).filter(item => item.inspectionId === inspection._id);
    const itemsByPhotoId = new Map();
    inspectionItems.forEach(item => {
      const key = item.sourcePhotoId || "";
      if (key && !itemsByPhotoId.has(key)) itemsByPhotoId.set(key, item);
    });

    (Array.isArray(inspection.photos) ? inspection.photos : []).forEach((photo, photoIndex) => {
      const sourcePhotoId = photo.id || `legacy-photo-${inspection._id}-${photoIndex}`;
      const sourceItem = itemsByPhotoId.get(sourcePhotoId) || {};
      const imageUrl = photo.annotatedImagePath || photo.imagePath || photo.sourceOriginalImagePath || "";
      if (!imageUrl) return;
      seenPhotoIds.add(`${inspection._id}:${sourcePhotoId}`);
      photos.push({
        id: `${inspection._id}-${sourcePhotoId}`,
        imageUrl,
        originalImageUrl: photo.imagePath || photo.sourceOriginalImagePath || "",
        inspectionId: inspection._id,
        inspectionTitle: inspection.title || "未命名巡查",
        createdAt: inspection.createdAt || sourceItem.createdAt,
        area: sourceItem.area || "",
        category: sourceItem.category || "",
        description: sourceItem.description || "",
        voiceText: photo.voiceText || sourceItem.voiceText || "",
        annotationsCount: (photo.annotations || sourceItem.annotations || []).length
      });
    });
  });

  // 兼容旧记录：旧巡查可能没有 inspections.photos，只在问题子项里保存图片。
  // 仅在照片级证据没有覆盖时补入，避免同一张照片因多个问题重复出现在相册。
  (items || []).forEach((item) => {
    const inspection = inspectionMap[item.inspectionId];
    if(!inspection)return;
    const sourcePhotoId = item.sourcePhotoId || "";
    const photoKey = `${item.inspectionId}:${sourcePhotoId || item._id}`;
    if (sourcePhotoId && seenPhotoIds.has(photoKey)) return;
    (item.images || []).forEach((imageUrl, imageIndex) => {
      if (!imageUrl) return;
      photos.push({
        id: `${item._id}-${imageIndex}`,
        imageUrl,
        inspectionId: item.inspectionId,
        inspectionTitle: inspection.title || "未命名巡查",
        createdAt: inspection.createdAt || item.createdAt,
        area: item.area || "",
        category: item.category || "",
        description: item.description || "",
        voiceText: item.voiceText || "",
        annotationsCount: (item.annotations || []).length
      });
    });
    if (sourcePhotoId) seenPhotoIds.add(photoKey);
  });

  return {
    success: true,
    data: {
      project,
      total: photos.length,
      inspectionsTotal: inspections.length,
      photos
    }
  };
}

async function removeProject(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertProjectOwner(payload.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  await db.collection("projects").doc(payload.projectId).update({
    data: {
      deleted: true,
      updatedAt: Date.now(),
      updatedBy: OPENID
    }
  });

  return {
    success: true,
    data: true
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "create":
      return createProject(payload);
    case "update":
      return updateProject(payload);
    case "list":
      return listProjects(payload);
    case "detail":
      return detailProject(payload);
    case "gallery":
      return galleryProject(payload);
    case "remove":
      return removeProject(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
