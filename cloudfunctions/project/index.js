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
    return (await all(queryRef)).filter(row=>row.status!=="preparing");
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
  const result = {data:await all(db.collection("projects").where({ownerOpenId:OPENID,deleted:false}).orderBy("updatedAt","desc"))};

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
    const inspections = {data:await all(db.collection("inspections").where({deleted:false,projectId:_.in(projectIds)}))};
    const inspectionItems = {data:await all(db.collection("inspection_items").where({deleted:false,projectId:_.in(projectIds)}))};
    const reports = {data:await all(db.collection("reports").where({deleted:false,projectId:_.in(projectIds)}))};

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
    safeGetList(db.collection("inspections").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc")),
    safeGetList(db.collection("reports").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc")),
    safeGetList(db.collection("memos").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc")),
    safeGetList(db.collection("chat_analysis").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc"))
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
    safeGetList(db.collection("inspections").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc")),
    safeGetList(db.collection("inspection_items").where({
      projectId: payload.projectId,
      deleted: false
    }).orderBy("createdAt", "desc"))
  ]);

  const inspectionMap = (inspections || []).reduce((accumulator, item) => {
    accumulator[item._id] = item;
    return accumulator;
  }, {});

  const photos = [];
  (items || []).forEach((item) => {
    const inspection = inspectionMap[item.inspectionId];
    if(!inspection)return;
    (item.images || []).forEach((imageUrl, imageIndex) => {
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
