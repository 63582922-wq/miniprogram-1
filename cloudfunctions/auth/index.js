const cloud = require("wx-server-sdk");
const crypto = require("crypto");

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
const PRIVACY_REQUEST_TYPES = ["查阅/复制", "更正", "删除个人信息", "注销账号", "撤回同意", "其他"];

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
  // 历史账号记录可能没有 deleted 字段。只排除明确删除的记录，
  // 否则新版登录会误判“没有账号”，再创建第二条 openId 相同的资料，
  // 造成我的页面、报告署名和联系电话看起来随机丢失。
  const result = await db.collection("users").where({ openId }).get();
  return (result.data || [])
    .filter((row) => row && row.deleted !== true)
    .sort((first, second) => {
      const firstTime = Number(first.updatedAt || first.createdAt || 0);
      const secondTime = Number(second.updatedAt || second.createdAt || 0);
      return secondTime - firstTime;
    })[0] || null;
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
    nickname: "",
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

  if (data.nickname === "巡查员") {
    return { success: false, message: "请填写实际巡查人姓名，不能只填“巡查员”" };
  }

  // 先拿到已经兼容解析出的当前用户，再按文档 ID 更新。这样旧账号即使
  // 没有 deleted 字段也能保存，而且不会把同一 openId 下的已删除历史记录一起改掉。
  const currentUser = await ensureUser(OPENID);

  const result = await db.collection("users").doc(currentUser._id).update({
    data: Object.assign({}, data, {
      updatedAt: Date.now(),
      updatedBy: OPENID
    })
  });

  // doc.update 在不同云 SDK 版本中可能不返回 stats；真正的不存在会直接抛错。
  if (result && result.stats && result.stats.updated === 0) {
    return {
      success: false,
      message: "保存失败，请重试"
    };
  }

  return getCurrentUser();
}

async function submitPrivacyRequest(payload) {
  const { OPENID } = cloud.getWXContext();
  const requestType = `${payload && payload.requestType || ""}`.trim();
  const details = `${payload && payload.details || ""}`.trim().slice(0, 500);
  const requestId = `${payload && payload.requestId || ""}`.trim().slice(0, 80);
  if (!PRIVACY_REQUEST_TYPES.includes(requestType)) {
    return { success: false, message: "请选择有效的申请事项" };
  }
  if (!/^[\w-]{12,80}$/.test(requestId)) return {success:false,message:"申请状态异常，请重新提交"};
  await ensureUser(OPENID);
  const id = `privacy-${crypto.createHash("sha256").update(`${OPENID}:${requestId}`).digest("hex")}`;
  const prior = await db.collection("privacy_requests").doc(id).get().catch(()=>null);
  if (prior && prior.data && prior.data.openId === OPENID) {
    return {success:true,data:{_id:id,requestType:prior.data.requestType,status:prior.data.status,createdAt:prior.data.createdAt}};
  }
  const now = Date.now();
  const request = {
    _id:id,
    openId: OPENID,
    requestId,
    requestType,
    details,
    status: "received",
    createdAt: now,
    updatedAt: now
  };
  try {
    await db.collection("privacy_requests").add({data:request});
  } catch (error) {
    const duplicate = await db.collection("privacy_requests").doc(id).get().catch(()=>null);
    if (!duplicate || !duplicate.data || duplicate.data.openId !== OPENID) throw error;
    return {success:true,data:{_id:id,requestType:duplicate.data.requestType,status:duplicate.data.status,createdAt:duplicate.data.createdAt}};
  }
  return { success:true, data:{_id:id,requestType,status:"received",createdAt:now} };
}

async function listPrivacyRequests() {
  const { OPENID } = cloud.getWXContext();
  const result = await db.collection("privacy_requests").where({openId:OPENID}).get();
  return {success:true,data:(result.data||[]).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,20).map(row=>({
    _id:row._id,requestType:row.requestType,status:row.status,response:row.response||"",createdAt:row.createdAt,updatedAt:row.updatedAt
  }))};
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
      case "submitPrivacyRequest":
        return await submitPrivacyRequest(payload);
      case "listPrivacyRequests":
        return await listPrivacyRequests();
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
