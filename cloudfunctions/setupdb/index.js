/**
 * 一次性数据库初始化函数（管理员使用，建完可删除）。
 *
 * 背景：微信云开发不会在写入时自动创建集合，缺集合会直接报
 * -502005 database collection not exists。手工在控制台建 10 个集合很繁琐，
 * 所以用这个函数一次建齐。
 *
 * 使用方式：开发者工具 → 云开发控制台 → 云函数 → setupdb → 云端测试 → 直接调用。
 * 幂等：已存在的集合会被跳过，可以重复调用。
 */

const cloud = require("wx-server-sdk");

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

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
  "ai_tasks"
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
