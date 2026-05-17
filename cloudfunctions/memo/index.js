const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();
const _ = db.command;

async function assertMemoAccess(memoId, openId) {
  const memoDoc = await db.collection("memos").doc(memoId).get();
  const memo = memoDoc.data;
  if (!memo || memo.deleted) {
    return {
      ok: false,
      message: "待办不存在"
    };
  }
  if (memo.createdBy === openId) {
    return {
      ok: true,
      memo
    };
  }
  if (memo.projectId) {
    const proj = await db.collection("projects").doc(memo.projectId).get();
    const project = proj.data;
    if (project && !project.deleted && project.ownerOpenId === openId) {
      return {
        ok: true,
        memo
      };
    }
  }
  return {
    ok: false,
    message: "无权操作该待办"
  };
}

function isCloudFileId(value) {
  return typeof value === "string" && value.startsWith("cloud://");
}

function normalizeMemoStatus(value) {
  if (value === "completed") {
    return "completed";
  }
  if (value === "closed") {
    return "closed";
  }
  return "pending";
}

function normalizeSubscribeStatus(value) {
  if (value === "accepted") {
    return "accepted";
  }
  if (value === "rejected") {
    return "rejected";
  }
  return "pending";
}

function buildVoiceFields(payload = {}, currentData = {}) {
  const rawVoiceFileId = payload.voiceFileId || currentData.voiceFileId || "";
  const rawVoiceFilePath = payload.voiceFilePath || currentData.voiceFilePath || "";
  const rawVoiceStorageFileId = payload.voiceStorageFileId || currentData.voiceStorageFileId || "";

  const voiceStorageFileId = rawVoiceStorageFileId || (isCloudFileId(rawVoiceFileId) ? rawVoiceFileId : "");
  const voiceFilePath = rawVoiceFilePath || (!isCloudFileId(rawVoiceFileId) ? rawVoiceFileId : "");

  return {
    voiceFilePath,
    voiceStorageFileId,
    voiceFileId: voiceStorageFileId
  };
}

async function createMemo(payload) {
  const { OPENID } = cloud.getWXContext();
  if (payload.projectId) {
    const proj = await db.collection("projects").doc(payload.projectId).get();
    const project = proj.data;
    if (!project || project.deleted || project.ownerOpenId !== OPENID) {
      return {
        success: false,
        message: "无权在该项目下创建待办"
      };
    }
  }
  const now = Date.now();
  const voiceFields = buildVoiceFields(payload);
  const data = {
    projectId: payload.projectId || "",
    content: payload.content || "",
    ...voiceFields,
    voiceText: payload.voiceText || "",
    remindAt: payload.remindAt || "",
    subscribeTemplateId: "worksite-inspection-reminder",
    subscribeStatus: normalizeSubscribeStatus(payload.subscribeStatus),
    status: normalizeMemoStatus(payload.status),
    deleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: OPENID,
    updatedBy: OPENID
  };
  const created = await db.collection("memos").add({
    data
  });

  return {
    success: true,
    data: {
      ...data,
      _id: created._id
    }
  };
}

async function updateMemo(payload) {
  const { OPENID } = cloud.getWXContext();
  const access = await assertMemoAccess(payload.memoId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  const current = await db.collection("memos").doc(payload.memoId).get();
  const voiceFields = buildVoiceFields(payload, current.data || {});
  await db.collection("memos").doc(payload.memoId).update({
    data: {
      content: payload.content,
      ...voiceFields,
      voiceText: payload.voiceText || "",
      remindAt: payload.remindAt || "",
      subscribeStatus: normalizeSubscribeStatus(payload.subscribeStatus || (current.data && current.data.subscribeStatus)),
      status: normalizeMemoStatus(payload.status || (current.data && current.data.status)),
      updatedAt: Date.now(),
      updatedBy: OPENID
    }
  });

  const memo = await db.collection("memos").doc(payload.memoId).get();
  return {
    success: true,
    data: memo.data
  };
}

async function listMemos(payload) {
  const { OPENID } = cloud.getWXContext();
  const projects = await db.collection("projects").where({
    ownerOpenId: OPENID,
    deleted: false
  }).get();
  const projectIds = (projects.data || []).map((item) => item._id);
  const orList = [
    {
      createdBy: OPENID
    }
  ];
  if (projectIds.length) {
    orList.push({
      projectId: _.in(projectIds)
    });
  }
  const result = await db.collection("memos").where(
    _.and([
      {
        deleted: false
      },
      _.or(orList)
    ])
  ).orderBy("createdAt", "desc").get();
  const now = Date.now();
  const list = (result.data || []).filter((item) => {
    if (payload.projectId && item.projectId !== payload.projectId) {
      return false;
    }
    if (payload.dueOnly && item.remindAt) {
      return new Date(item.remindAt).getTime() <= now;
    }
    return true;
  });

  return {
    success: true,
    data: {
      list: list.map((item) => ({
        ...item,
        status: normalizeMemoStatus(item.status),
        statusText: normalizeMemoStatus(item.status) === "completed"
          ? "已完成"
          : normalizeMemoStatus(item.status) === "closed"
            ? "已关闭"
            : "待处理",
        voiceStorageFileId: item.voiceStorageFileId || (isCloudFileId(item.voiceFileId) ? item.voiceFileId : ""),
        voiceFilePath: item.voiceFilePath || (!isCloudFileId(item.voiceFileId) ? item.voiceFileId : ""),
        voiceFileId: item.voiceStorageFileId || (isCloudFileId(item.voiceFileId) ? item.voiceFileId : ""),
        remindAtText: item.remindAt || "未设置提醒",
        subscribeStatusText: item.subscribeStatus === "accepted"
          ? "已订阅提醒"
          : item.subscribeStatus === "rejected"
            ? "未订阅提醒"
            : "待订阅提醒"
      })),
      total: list.length
    }
  };
}

async function detailMemo(payload) {
  if (!payload.memoId) {
    return {
      success: false,
      message: "缺少待办ID"
    };
  }

  const { OPENID } = cloud.getWXContext();
  const access = await assertMemoAccess(payload.memoId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  return {
    success: true,
    data: access.memo
  };
}

async function deleteMemo(payload) {
  if (!payload.memoId) {
    return {
      success: false,
      message: "缺少待办ID"
    };
  }

  const { OPENID } = cloud.getWXContext();
  const access = await assertMemoAccess(payload.memoId, OPENID);
  if (!access.ok) {
    return {
      success: false,
      message: access.message
    };
  }
  await db.collection("memos").doc(payload.memoId).update({
    data: {
      deleted: true,
      updatedAt: Date.now(),
      updatedBy: OPENID
    }
  });

  return {
    success: true,
    data: {
      memoId: payload.memoId
    }
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "create":
      return createMemo(payload);
    case "update":
      return updateMemo(payload);
    case "list":
      return listMemos(payload);
    case "detail":
      return detailMemo(payload);
    case "delete":
      return deleteMemo(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
