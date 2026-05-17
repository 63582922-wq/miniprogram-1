const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

async function detail() {
  const { OPENID } = cloud.getWXContext();
  const result = await db.collection("app_settings").where({
    openId: OPENID,
    deleted: false
  }).get();

  return {
    success: true,
    data: result.data[0] || null
  };
}

async function save(payload) {
  const { OPENID } = cloud.getWXContext();
  const result = await db.collection("app_settings").where({
    openId: OPENID,
    deleted: false
  }).get();
  const now = Date.now();

  if (result.data.length) {
    await db.collection("app_settings").doc(result.data[0]._id).update({
      data: {
        companyName: payload.companyName || "",
        companyPhone: payload.companyPhone || "",
        companyAddress: payload.companyAddress || "",
        logoFileId: payload.logoFileId || "",
        reportTemplate: payload.reportTemplate || "default",
        reportPdfEngine: payload.reportPdfEngine || "canvas",
        reportPdfServiceUrl: payload.reportPdfServiceUrl || "",
        updatedAt: now,
        updatedBy: OPENID
      }
    });
  } else {
    await db.collection("app_settings").add({
      data: {
        openId: OPENID,
        companyName: payload.companyName || "",
        companyPhone: payload.companyPhone || "",
        companyAddress: payload.companyAddress || "",
        logoFileId: payload.logoFileId || "",
        reportTemplate: payload.reportTemplate || "default",
        reportPdfEngine: payload.reportPdfEngine || "canvas",
        reportPdfServiceUrl: payload.reportPdfServiceUrl || "",
        deleted: false,
        createdAt: now,
        updatedAt: now,
        createdBy: OPENID,
        updatedBy: OPENID
      }
    });
  }

  return detail();
}

exports.main = async (event) => {
  const { action, payload = {} } = event;

  switch (action) {
    case "detail":
      return detail();
    case "save":
      return save(payload);
    default:
      return {
        success: false,
        message: "未知操作"
      };
  }
};
