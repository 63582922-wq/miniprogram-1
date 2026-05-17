const cloud = require("wx-server-sdk");

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

async function listInspections(payload = {}) {
  const { OPENID } = cloud.getWXContext();
  const projects = await db.collection("projects").where({
    ownerOpenId: OPENID,
    deleted: false
  }).get();
  const projectMap = (projects.data || []).reduce((accumulator, item) => {
    accumulator[item._id] = item.name;
    return accumulator;
  }, {});

  const projectIds = Object.keys(projectMap);
  if (!projectIds.length) {
    return {
      success: true,
      data: {
        list: [],
        total: 0
      }
    };
  }

  const query = {
    deleted: false,
    projectId: _.in(projectIds)
  };

  if (payload.projectId) {
    if (!projectMap[payload.projectId]) {
      return {
        success: true,
        data: {
          list: [],
          total: 0
        }
      };
    }
    query.projectId = payload.projectId;
  }

  const result = await db.collection("inspections").where(query).orderBy("createdAt", "desc").get();

  return {
    success: true,
    data: {
      list: (result.data || []).map((item) => ({
        ...item,
        projectName: projectMap[item.projectId] || ""
      })),
      total: result.data.length
    }
  };
}

async function confirmInspection(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertProjectOwner(payload.form.projectId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const now = Date.now();
  const issueDraftMap = (payload.form.issueDrafts || []).reduce((accumulator, item, index) => {
    accumulator[index] = item;
    return accumulator;
  }, {});
  const originalItemMap = (payload.originalItems || []).reduce((accumulator, item, index) => {
    accumulator[index] = item;
    return accumulator;
  }, {});
  const inspection = {
    projectId: payload.form.projectId,
    title: payload.form.title || `巡查-${now}`,
    inspectionDate: now,
    inspectorOpenId: OPENID,
    status: "submitted",
    issueCount: payload.items.length,
    severitySummary: payload.items.map((item) => item.severity).join(","),
    reportId: "",
    note: payload.form.note || "",
    aiSummary: payload.form.aiSummary || "",
    deleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: OPENID,
    updatedBy: OPENID
  };

  const createdInspection = await db.collection("inspections").add({
    data: inspection
  });

  await Promise.all((payload.items || []).map((item, index) => {
    const sourceDraft = issueDraftMap[item.sourceIndex] || {};
    const images = item.images && item.images.length
      ? item.images
      : sourceDraft.imagePath
        ? [sourceDraft.imagePath]
        : payload.form.images || [];
    const annotations = item.annotations || sourceDraft.annotations || [];
    const annotatedImages = item.annotatedImages && item.annotatedImages.length
      ? item.annotatedImages
      : sourceDraft.annotatedImagePath
        ? [sourceDraft.annotatedImagePath]
        : annotations.length && sourceDraft.imagePath
          ? [sourceDraft.imagePath]
        : images;
    const voiceFields = normalizeVoiceFields(item, sourceDraft);
    const aiRawResult = originalItemMap[index] || item;

    return db.collection("inspection_items").add({
      data: {
        inspectionId: createdInspection._id,
        projectId: payload.form.projectId,
        area: item.area || "",
        category: item.category || "",
        severity: item.severity || "normal",
        responsibleParty: item.responsibleParty || "pending",
        description: item.description || "",
        suggestion: item.suggestion || "",
        images,
        annotatedImages,
        annotations,
        ...voiceFields,
        voiceText: item.voiceText || sourceDraft.voiceText || "",
        aiRawResult,
        confirmStatus: "confirmed",
        sortOrder: index,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        createdBy: OPENID,
        updatedBy: OPENID
      }
    });
  }));

  await db.collection("projects").doc(payload.form.projectId).update({
    data: {
      lastInspectionAt: now,
      updatedAt: now,
      updatedBy: OPENID
    }
  });

  return {
    success: true,
    data: {
      inspectionId: createdInspection._id
    }
  };
}

async function detailInspection(payload) {
  const { OPENID } = cloud.getWXContext();
  const inspection = await db.collection("inspections").doc(payload.inspectionId).get();
  if (!inspection.data || inspection.data.deleted) {
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
  const items = await db.collection("inspection_items").where({
    inspectionId: payload.inspectionId,
    deleted: false
  }).orderBy("sortOrder", "asc").get();
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
