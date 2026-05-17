const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

async function save(payload) {
  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  const result = await db.collection("subscriptions").where({
    openId: OPENID,
    scene: payload.scene,
    deleted: false
  }).get();

  if (result.data.length) {
    await db.collection("subscriptions").doc(result.data[0]._id).update({
      data: {
        templateId: payload.templateId,
        accepted: !!payload.accepted,
        lastSubscribedAt: now,
        updatedAt: now,
        updatedBy: OPENID
      }
    });
  } else {
    await db.collection("subscriptions").add({
      data: {
        openId: OPENID,
        scene: payload.scene,
        templateId: payload.templateId,
        accepted: !!payload.accepted,
        lastSubscribedAt: now,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        createdBy: OPENID,
        updatedBy: OPENID
      }
    });
  }

  return {
    success: true,
    data: true
  };
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "save":
      return save(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
