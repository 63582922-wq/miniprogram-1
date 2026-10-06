/**
 * 一次性数据库初始化函数（管理员使用，建完可删除）。
 *
 * 背景：微信云开发不会在写入时自动创建集合，缺集合会直接报
 * -502005 database collection not exists。手工在控制台建 10 个集合很繁琐，
 * 所以用这个函数一次建齐。
 *
 * 使用方式：开发者工具 → 云开发控制台 → 云函数 → setupdb → 云端测试 → 直接调用。
 * 幂等：已存在的集合会被跳过，可以重复调用。
 *
 * 访问控制（2026-10-06 从线上回写）：
 * 云函数只要部署了，任何小程序用户都能通过 wx.cloud.callFunction 调到它，
 * 微信云开发没有按函数配置调用方白名单的能力。所以守卫必须写在函数里。
 * 线上版本早已按这个思路加了 ADMIN_OPENIDS 校验，但当时只改在控制台、
 * 没有回写到仓库——**直接部署旧源码会把这道守卫抹掉**。
 */

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * 只有 ADMIN_OPENIDS 白名单内的账号可以调用；未配置白名单时整个函数停用。
 * 默认关闭而不是默认放开：忘了配就不会出事。
 */
function adminDeniedReason() {
  const allow = `${process.env.ADMIN_OPENIDS || ""}`
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  const { OPENID } = cloud.getWXContext();
  if (!allow.length || !allow.includes(OPENID)) {
    return "setupdb 未启用：请先在云函数环境变量中设置 ADMIN_OPENIDS（逗号分隔的 openid 白名单）";
  }
  return "";
}

/** 代码里实际使用的全部集合 */
const COLLECTIONS = [
  "users",
  "projects",
  "inspections",
  "inspection_items",
  "reports",
  "memos",
  "chat_analysis",
  "app_settings",
  "subscriptions",
  "ai_tasks",
  "privacy_requests"
];

/** 集合不存在时 createCollection 抛错，用错误信息判断是否「已存在」 */
function isAlreadyExists(error) {
  const text = `${(error && error.message) || ""} ${(error && error.errMsg) || ""}`.toLowerCase();
  return (
    text.includes("already exist") ||
    text.includes("已存在") ||
    text.includes("-502002")
  );
}

exports.main = async () => {
  const denied = adminDeniedReason();
  if (denied) {
    return {
      success: false,
      message: denied
    };
  }

  const created = [];
  const skipped = [];
  const failed = [];

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (error) {
      if (isAlreadyExists(error)) {
        skipped.push(name);
        continue;
      }
      failed.push({
        name,
        message: (error && error.message) || String(error)
      });
    }
  }

  const result = {
    success: failed.length === 0,
    created,
    skipped,
    failed,
    total: COLLECTIONS.length
  };

  console.log("[setupdb] done", result);
  return result;
};
