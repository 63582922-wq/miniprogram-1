/**
 * 本机照片文件的释放与清扫。
 *
 * 为什么需要它：现场照片经 keepLocalFile 落盘到 `wx.env.USER_DATA_PATH` ——
 * 那是**手机上的真实存储**，不是缓存。而此前提交报告或放弃草稿只清了
 * storage 键，文件全部留在手机里，并且全项目没有任何地方删除过它们
 * （`removeSavedFile` / `unlink` 在本次改动前只出现过一次，删的是标注用的临时文件）。
 *
 * 后果是随使用次数无限增长，直到微信给小程序的本机文件配额被占满。
 * 「报告在线上、不占手机内存」是产品的核心承诺，这里让它成立。
 *
 * 零依赖：既被 services/inspection-media 用，也被零依赖的
 * utils/inspection-draft 用。不要在这里 require 别的东西。
 */

function rootPath() {
  return (typeof wx !== "undefined" && wx.env && wx.env.USER_DATA_PATH)
    ? wx.env.USER_DATA_PATH + "/"
    : "";
}

/** 一份草稿引用到的本机文件路径（照片三份 + 语音）。 */
function collectLocalMediaPaths(draft) {
  const root = rootPath();
  if (!root) return [];
  const paths = new Set();
  const photos = (draft && draft.form && draft.form.issueDrafts) || [];
  const fields = [
    "sourceOriginalImagePath", "imagePath", "annotatedImagePath",
    "localOriginalImagePath", "localImagePath", "localAnnotatedImagePath",
    "voiceFilePath"
  ];
  photos.forEach((photo) => {
    fields.forEach((field) => {
      const value = photo && photo[field];
      if (typeof value === "string" && value.startsWith(root)) {
        paths.add(value);
      }
    });
  });
  return [...paths];
}

/**
 * 释放一份草稿占用的本机文件。提交完成或放弃草稿时调用。
 * 云端已有副本，此时删除是安全的；单个失败不影响其余，也不抛错——
 * 清理失败不该影响用户已经完成的提交。
 */
function releaseLocalMedia(draft) {
  const paths = collectLocalMediaPaths(draft);
  if (!paths.length || typeof wx === "undefined" || typeof wx.getFileSystemManager !== "function") {
    return Promise.resolve(0);
  }
  const fs = wx.getFileSystemManager();
  return Promise.all(paths.map((filePath) => new Promise((resolve) => {
    fs.unlink({ filePath, success: () => resolve(1), fail: () => resolve(0) });
  }))).then((results) => results.reduce((total, n) => total + n, 0));
}

/**
 * 清扫孤儿文件：删掉不再被任何草稿引用的本机照片。
 *
 * 定向释放只管「从今往后」；用户手机上可能已经攒下了历史遗留。
 * 在启动时对一次账，把没人认领的删掉。
 *
 * ⚠️ 两道保险，缺一不可——这是会删用户现场照片的代码：
 *
 * 1. **调用方必须确认已拿到用户身份**。草稿是按 openId 归属的，
 *    身份未知时 readDraft 一律返回空，listDrafts 也就是空，
 *    于是「没有任何草稿引用它」对**每一张照片**都成立，会把正在编辑的
 *    草稿照片一起删掉。所以 liveDrafts 的「空」必须是真的空。
 * 2. **只删创建超过 24 小时的文件**。刚拍进草稿、还没来得及落进 storage
 *    索引的照片，不该被一次启动误伤。
 */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

function sweepOrphanLocalMedia(liveDrafts = [], options = {}) {
  const root = rootPath();
  if (!root || typeof wx === "undefined" || typeof wx.getSavedFileList !== "function") {
    return Promise.resolve(0);
  }
  if (!options.identityConfirmed) {
    // 宁可留一会儿垃圾，也不误删用户的现场照片
    return Promise.resolve(0);
  }
  const now = Date.now();
  const minAge = Number(options.minAgeMs) || ORPHAN_MIN_AGE_MS;
  const keep = new Set();
  liveDrafts.forEach((draft) => collectLocalMediaPaths(draft).forEach((p) => keep.add(p)));
  const fs = wx.getFileSystemManager();
  return new Promise((resolve) => {
    wx.getSavedFileList({
      success: (result = {}) => {
        const orphans = (result.fileList || [])
          .map((item) => ({ filePath: item.filePath, createTime: Number(item.createTime) || 0 }))
          .filter((item) => item.filePath && item.filePath.startsWith(root))
          .filter((item) => !keep.has(item.filePath))
          // 只删「确定够旧」的：拿不到创建时间就留着。
          // 原来写的是 `!item.createTime || ...`——在不上报创建时间的平台上，
          // 24 小时这道保险会整个失效，等于只剩 keep 集合一道防线。
          // 不确定就别删，大不了下次启动再清。
          .filter((item) => item.createTime && (now - item.createTime * 1000) > minAge)
          .map((item) => item.filePath);
        if (!orphans.length) {
          resolve(0);
          return;
        }
        Promise.all(orphans.map((filePath) => new Promise((done) => {
          fs.unlink({ filePath, success: () => done(1), fail: () => done(0) });
        }))).then((results) => resolve(results.reduce((total, n) => total + n, 0)));
      },
      fail: () => resolve(0)
    });
  });
}

module.exports = { collectLocalMediaPaths, releaseLocalMedia, sweepOrphanLocalMedia };
