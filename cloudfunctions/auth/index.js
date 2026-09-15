const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * 客户端可自行修改的字段白名单。
 *
 * 这里绝不能写成 { ...payload }：users 集合里同时存着 openId、role、status、
 * deleted 这些安全敏感字段。整体展开会让调用方把 openId 改成别人的，从而冒充
 * 任意账号——而所有鉴权路径都建立在 where({ openId }) 之上，一旦被改，全线失守。
 */
const PROFILE_EDITABLE_FIELDS = ["nickname", "avatarUrl", "phone"];

const FIELD_MAX_LENGTH = {
  nickname: 40,
  avatarUrl: 500,
  phone: 30
};

/** 只保留白名单内的字符串字段，并做长度收敛 */
function pickEditableFields(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const data = {};

  PROFILE_EDITABLE_FIELDS.forEach((field) => {
    const value = source[field];
    if (typeof value !== "string") {
      return;
    }
    data[field] = value.trim().slice(0, FIELD_MAX_LENGTH[field] || 200);
  });

  return data;
}

async function findUser(openId) {
  const result = await db.collection("users").where({
    openId,
    deleted: false
  }).get();
  return result.data[0] || null;
}

/**
 * 取当前用户，不存在则创建。
 * 统一走这里可以避免「设置页保存时用户记录还没建好」导致的无提示失败。
 */
async function ensureUser(openId) {
  const existing = await findUser(openId);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const user = {
    openId,
    nickname: "巡查员",
    avatarUrl: "",
    phone: "",
    teamId: "",
    role: "owner",
    status: "active",
    deleted: false,
    createdAt: now,
    updatedAt: now,
    createdBy: openId,
    updatedBy: openId
  };

  const created = await db.collection("users").add({ data: user });
  return Object.assign({}, user, { _id: created._id });
}

async function initSession() {
  const { OPENID } = cloud.getWXContext();
  const user = await ensureUser(OPENID);
  return {
    success: true,
    data: user
  };
}

async function getCurrentUser() {
  const { OPENID } = cloud.getWXContext();
  const user = await findUser(OPENID);
  return {
    success: true,
    data: user
  };
}

async function updateProfile(payload) {
  const { OPENID } = cloud.getWXContext();
  const data = pickEditableFields(payload);

  if (!Object.keys(data).length) {
    return {
      success: false,
      message: "没有可更新的字段"
    };
  }

  // 先确保用户存在，否则 update 会命中 0 条而静默失败
  await ensureUser(OPENID);

  const result = await db.collection("users").where({
    openId: OPENID,
    deleted: false
  }).update({
    data: Object.assign({}, data, {
      updatedAt: Date.now(),
      updatedBy: OPENID
    })
  });

  if (!result.stats || result.stats.updated === 0) {
    return {
      success: false,
      message: "保存失败，请重试"
    };
  }

  return getCurrentUser();
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  try {
    switch (action) {
      case "initSession":
        return await initSession();
      case "getCurrentUser":
        return await getCurrentUser();
      case "updateProfile":
        return await updateProfile(payload);
      default:
        return {
          success: false,
          message: "未知操作"
        };
    }
  } catch (error) {
    console.error("[auth] action failed", {
      action,
      message: error && error.message,
      stack: error && error.stack
    });
    return {
      success: false,
      message: (error && error.message) || "服务异常，请稍后重试"
    };
  }
};
