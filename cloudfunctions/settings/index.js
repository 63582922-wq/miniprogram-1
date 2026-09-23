const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

function newestActive(rows = []) {
  return rows
    .filter((row) => row && row.deleted !== true)
    .sort((first, second) => {
      const firstTime = Number(first.updatedAt || first.createdAt || 0);
      const secondTime = Number(second.updatedAt || second.createdAt || 0);
      return secondTime - firstTime;
    })[0] || null;
}

async function findSettings(openId) {
  // 旧版资料可能没有 deleted 字段。只排除明确标记为 deleted:true 的记录，
  // 否则历史 LOGO 与公司资料会在新版界面里被误判为不存在。
  const result = await db.collection("app_settings").where({
    openId
  }).get();
  return newestActive(result.data);
}

async function detail() {
  const { OPENID } = cloud.getWXContext();
  const settings = await findSettings(OPENID);

  return {
    success: true,
    data: settings
  };
}

async function save(payload) {
  const { OPENID } = cloud.getWXContext();
  const settings = await findSettings(OPENID);
  const now = Date.now();

  if (settings) {
    await db.collection("app_settings").doc(settings._id).update({
      data: {
        companyName: payload.companyName || "",
        companyPhone: payload.companyPhone || "",
        companyAddress: payload.companyAddress || "",
        logoFileId: payload.logoFileId || "",
        reportTemplate: payload.reportTemplate || "default",
        reportPdfEngine: payload.reportPdfEngine || "canvas",
        reportPdfServiceUrl: payload.reportPdfServiceUrl || "",
        deleted: false,
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
