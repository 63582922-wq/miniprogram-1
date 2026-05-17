const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

async function initSession() {
  const { OPENID } = cloud.getWXContext();
  const collection = db.collection("users");
  const existing = await collection.where({
    openId: OPENID,
    deleted: false
  }).get();

  if (!existing.data.length) {
    const now = Date.now();
    const user = {
      openId: OPENID,
      nickname: "巡查员",
      avatarUrl: "",
      phone: "",
      teamId: "",
      role: "owner",
      status: "active",
      deleted: false,
      createdAt: now,
      updatedAt: now,
      createdBy: OPENID,
      updatedBy: OPENID
    };
    const created = await collection.add({
      data: user
    });
    return {
      success: true,
      data: {
        ...user,
        _id: created._id
      }
    };
  }

  return {
    success: true,
    data: existing.data[0]
  };
}

async function getCurrentUser() {
  const { OPENID } = cloud.getWXContext();
  const result = await db.collection("users").where({
    openId: OPENID,
    deleted: false
  }).get();

  return {
    success: true,
    data: result.data[0] || null
  };
}

async function updateProfile(payload) {
  const { OPENID } = cloud.getWXContext();
  await db.collection("users").where({
    openId: OPENID,
    deleted: false
  }).update({
    data: {
      ...payload,
      updatedAt: Date.now(),
      updatedBy: OPENID
    }
  });

  return getCurrentUser();
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "initSession":
      return initSession();
    case "getCurrentUser":
      return getCurrentUser();
    case "updateProfile":
      return updateProfile(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
