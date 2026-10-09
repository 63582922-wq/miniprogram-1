#!/usr/bin/env node
/**
 * 一次性创建全部数据库索引。
 *
 * 为什么需要它：云开发按「读取次数」计费，而没有索引的 where 查询是全表扫描——
 * 集合 1000 行，每次查询就读 1000 次。慢和贵是同一个原因。
 *
 * 为什么不能由云函数自动建：已确认 wx-server-sdk 连最新版 4.0.2 都只暴露
 * createCollection，没有 createIndex；管理端 HTTP 接口（本脚本用的那个）
 * 需要 access_token，而换 token 要 AppSecret。**把 AppSecret 放进云函数
 * 环境变量是拿一个更贵的凭据去换一个更便宜的问题**，所以做成手动跑一次。
 *
 * 用法：
 *   WX_APPSECRET=xxx node scripts/ensure-indexes.cjs
 *   WX_APPSECRET=xxx node scripts/ensure-indexes.cjs --dry-run
 *
 * 可选环境变量：
 *   WX_APPID   默认取仓库里的 AppID
 *   TCB_ENV    默认取仓库里的云环境 ID
 *   WX_APPSECRET  ← 必填。脚本不读文件、不写文件、不回显它。
 *
 * 幂等：重复跑不会重复建；已存在的索引会被接口拒绝，脚本按「已存在」处理并继续。
 */

const https = require("node:https");

const APPID = process.env.WX_APPID || "wxf30ba9025bea84ab";
const ENV_ID = process.env.TCB_ENV || "cloud1-d4ge4gu1le8fe61d3";
const APPSECRET = process.env.WX_APPSECRET || "";
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * 索引清单 —— 与 docs/上线后运营维护体系.md 第三节保持一致。
 *
 * 字段顺序遵循「等值在前、排序在后」，这样 where 与 orderBy 能命中同一个索引。
 * direction: "1" 升序，"-1" 降序。
 */
const INDEXES = [
  { collection: "projects", name: "owner_created",
    unique: false, keys: [{ name: "ownerOpenId", direction: "1" }, { name: "createdAt", direction: "-1" }] },

  { collection: "inspections", name: "project_created",
    unique: false, keys: [{ name: "projectId", direction: "1" }, { name: "createdAt", direction: "-1" }] },

  { collection: "inspections", name: "inspector_created",
    unique: false, keys: [{ name: "inspectorOpenId", direction: "1" }, { name: "createdAt", direction: "-1" }] },

  { collection: "inspection_items", name: "inspection_deleted_sort",
    unique: false, keys: [
      { name: "inspectionId", direction: "1" },
      { name: "deleted", direction: "1" },
      { name: "sortOrder", direction: "1" }
    ] },

  { collection: "reports", name: "project_created",
    unique: false, keys: [{ name: "projectId", direction: "1" }, { name: "createdAt", direction: "-1" }] },

  { collection: "reports", name: "inspection_deleted",
    unique: false, keys: [{ name: "inspectionId", direction: "1" }, { name: "deleted", direction: "1" }] },

  // 唯一索引：代码按 openId 取「最新一条」，不唯一时并发写入会产生重复账号记录。
  // 注意：记录若缺失该字段，索引视其为 null，唯一索引不允许两条及以上为空——
  // 所以创建失败本身就说明集合里已有脏数据，应先排查。
  { collection: "users", name: "openId_unique",
    unique: true, keys: [{ name: "openId", direction: "1" }] },

  { collection: "app_settings", name: "openId_unique",
    unique: true, keys: [{ name: "openId", direction: "1" }] },

  { collection: "privacy_requests", name: "openId_created",
    unique: false, keys: [{ name: "openId", direction: "1" }, { name: "createdAt", direction: "-1" }] }
];

function request(url, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(url, {
      method: payload ? "POST" : "GET",
      headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (error) { reject(new Error(`响应不是合法 JSON：${raw.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getAccessToken() {
  const url = "https://api.weixin.qq.com/cgi-bin/token"
    + `?grant_type=client_credential&appid=${encodeURIComponent(APPID)}&secret=${encodeURIComponent(APPSECRET)}`;
  const result = await request(url);
  if (!result.access_token) {
    // 不要把 APPSECRET 带进任何输出
    throw new Error(`获取 access_token 失败：errcode=${result.errcode} errmsg=${result.errmsg}`);
  }
  return result.access_token;
}

async function createIndex(token, entry) {
  const url = `https://api.weixin.qq.com/tcb/updateindex?access_token=${encodeURIComponent(token)}`;
  return request(url, {
    env: ENV_ID,
    collection_name: entry.collection,
    create_indexes: [{ name: entry.name, unique: entry.unique, keys: entry.keys }],
    drop_indexes: []
  });
}

async function main() {
  console.log(`AppID  ${APPID}`);
  console.log(`环境   ${ENV_ID}`);
  console.log(`索引   ${INDEXES.length} 条，分布在 ${new Set(INDEXES.map((i) => i.collection)).size} 个集合`);
  console.log("");

  for (const entry of INDEXES) {
    const fields = entry.keys.map((k) => `${k.name}${k.direction === "-1" ? "↓" : "↑"}`).join(" + ");
    console.log(`  ${entry.collection.padEnd(18)} ${entry.name.padEnd(24)} ${fields}${entry.unique ? "   [唯一]" : ""}`);
  }
  console.log("");

  if (DRY_RUN) {
    console.log("--dry-run：只打印计划，未调用接口。");
    return;
  }
  if (!APPSECRET) {
    console.error("缺少 WX_APPSECRET。用法：WX_APPSECRET=xxx node scripts/ensure-indexes.cjs");
    console.error("（脚本不会把它写进任何文件，也不会回显。）");
    process.exitCode = 1;
    return;
  }

  const token = await getAccessToken();
  console.log("已获取 access_token（不显示，不落盘）\n");

  let created = 0, existing = 0, failed = 0;
  for (const entry of INDEXES) {
    const label = `${entry.collection}.${entry.name}`;
    try {
      const result = await createIndex(token, entry);
      if (result.errcode === 0) {
        created += 1;
        console.log(`  ✅ 已创建  ${label}`);
        continue;
      }
      // 已存在时接口会报错；把它与真正的失败区分开，保证脚本可重复跑
      const text = `${result.errmsg || ""}`;
      if (/exist|already|重复|已存在/i.test(text)) {
        existing += 1;
        console.log(`  ⏭  已存在  ${label}`);
        continue;
      }
      failed += 1;
      console.error(`  ❌ 失败    ${label}  errcode=${result.errcode} errmsg=${text}`);
      if (entry.unique && /duplicate|null/i.test(text)) {
        console.error("     ↑ 唯一索引建不上，通常说明集合里已有重复或缺失该字段的数据，应先排查数据。");
      }
    } catch (error) {
      failed += 1;
      console.error(`  ❌ 失败    ${label}  ${error.message}`);
    }
  }

  console.log(`\n合计：新建 ${created}，已存在 ${existing}，失败 ${failed}`);
  console.log("验证：云开发控制台 → 数据库 → 选中集合 → 索引管理，看「命中次数」是否随使用增长。");
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
