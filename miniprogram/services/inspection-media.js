const { uploadUserFile } = require("./cloud");

function keepLocalFile(path) {
  if (!path || path.startsWith("cloud://") || (wx.env && path.startsWith(wx.env.USER_DATA_PATH + "/"))) return Promise.resolve(path || "");
  return new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({
    tempFilePath: path,
    success: r => resolve(r.savedFilePath),
    fail: () => reject(new Error("本机存储失败，请释放空间后重试；请勿关闭当前记录"))
  }));
}

// Persist each completed upload immediately; a later failure must not lose receipts.
async function uploadDraftMedia(form, onProgress = () => {}) {
  const next = { ...form, issueDrafts: (form.issueDrafts || []).map(p => ({ ...p })) };
  for (let i = 0; i < next.issueDrafts.length; i++) {
    const p = next.issueDrafts[i];
    if (p.annotationDirty) throw new Error(`第 ${i + 1} 张照片的标注尚未导出，请打开标注并保存后继续`);
    for (const [field, folder] of [["sourceOriginalImagePath", "inspection-originals"], ["imagePath", "inspection-images"], ["annotatedImagePath", "inspection-annotated-images"]]) {
      if (p[field] && !p[field].startsWith("cloud://")) {
        const local = p[field];
        p[field] = await uploadUserFile(local, folder, `${p.id || i}.png`);
        p[field === "imagePath" ? "localImagePath" : field === "sourceOriginalImagePath" ? "localOriginalImagePath" : "localAnnotatedImagePath"] = local;
        await onProgress(next);
      }
    }
    if (p.voiceFilePath && !p.voiceStorageFileId) {
      p.voiceStorageFileId = await uploadUserFile(p.voiceFilePath, "inspection-audio", `${p.id || i}.mp3`);
      p.voiceFileId = p.voiceStorageFileId;
      await onProgress(next);
    }
  }
  next.images = next.issueDrafts.map(p => p.imagePath).filter(Boolean);
  return next;
}
module.exports = { keepLocalFile, uploadDraftMedia };
