#!/usr/bin/env node
/**
 * 上传体验/开发版本。
 *
 * 为什么要包一层：微信只在**体验版和正式版**下发版本号
 * （`wx.getAccountInfoSync().miniProgram.version`）。
 * 开发版里那个字段是空的——于是「我现在装的是哪一版」在最需要确认的
 * 场景下反而看不到。
 *
 * 既然只有上传这一步知道版本，就在上传前把版本号写进代码里，
 * 应用读不到平台版本号时回退到它。
 *
 * 用法：
 *   node scripts/upload.cjs <版本号> "<版本描述>"
 *   node scripts/upload.cjs 1.0.28 "修了什么"
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const BUILD_INFO = path.join(ROOT, "miniprogram/build-info.js");
const CLI = "/Applications/wechatwebdevtools.app/Contents/MacOS/cli";
const QR = "/tmp/dsh-upload-qr.png";

const version = process.argv[2];
const desc = process.argv[3] || "";

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：node scripts/upload.cjs <版本号，如 1.0.28> \"<版本描述>\"");
  process.exit(1);
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch (_error) {
    return "";
  }
}

const commit = git(["rev-parse", "--short", "HEAD"]);
const builtAt = new Date().toISOString().slice(0, 10);

// 这份文件由脚本生成，是「当前代码对应哪次上传」的唯一线索。
// 开发版拿不到平台版本号时，应用回退到这里。
const generated = `/**
 * 由 scripts/upload.cjs 在上传前生成，请勿手改。
 *
 * 微信只在体验版/正式版下发版本号，开发版的 version 是空的。
 * 应用读不到平台版本号时回退到这里，好让「我装的是哪一版」始终有答案。
 */
module.exports = {
  version: ${JSON.stringify(version)},
  builtAt: ${JSON.stringify(builtAt)},
  commit: ${JSON.stringify(commit)}
};
`;

fs.writeFileSync(BUILD_INFO, generated, "utf8");
console.log(`已写入 build-info：${version}（${commit || "无提交信息"}，${builtAt}）`);

console.log("上传中…");
execFileSync(CLI, [
  "upload",
  "--project", ROOT,
  "--version", version,
  "--desc", desc,
  "--qr-output", QR,
  "--lang", "zh"
], { stdio: "inherit" });

console.log(`\n完成。版本 ${version} 已上传。`);
console.log("接下来：公众平台 → 版本管理 → 开发版本 → 右侧「∨」→ 选为体验版。");
