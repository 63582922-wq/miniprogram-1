const { uploadUserFile } = require("./cloud");

function keepLocalFile(path) {
  if (!path || path.startsWith("cloud://") || (wx.env && path.startsWith(wx.env.USER_DATA_PATH + "/"))) return Promise.resolve(path || "");
  return new Promise((resolve, reject) => wx.getFileSystemManager().saveFile({
    tempFilePath: path,
    success: r => resolve(r.savedFilePath),
    fail: () => reject(new Error("本机存储失败，请释放空间后重试；请勿关闭当前记录"))
  }));
}

// Keep a small bounded upload window: parallelize independent photos without
// flooding mobile radios or the device's file/network resources.
async function uploadDraftMedia(form, onProgress = () => {}, concurrency = 3) {
  const next = { ...form, issueDrafts: (form.issueDrafts || []).map(p => ({ ...p })) };
  const entries = next.issueDrafts;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].annotationDirty) throw new Error(`第 ${i + 1} 张照片的标注尚未导出，请打开标注并保存后继续`);
  }
  const fieldsToUpload = ["sourceOriginalImagePath", "imagePath", "annotatedImagePath"];
  const totalFiles = entries.reduce((total, photo) => total
    + fieldsToUpload.filter(field => photo[field] && !photo[field].startsWith("cloud://")).length
    + (photo.voiceFilePath && !photo.voiceStorageFileId ? 1 : 0), 0);
  let completedFiles = 0;

  // A resumed draft may already have every media receipt. Do not manufacture
  // a progress event such as “1/0”; callers already persist the current form
  // before entering this function and will persist the returned snapshot.
  if (!totalFiles) {
    next.images = next.issueDrafts.map(p => p.imagePath).filter(Boolean);
    return next;
  }

  // Callers persist each receipt into the draft. Serialize those checkpoints
  // so a slower storage write can never overwrite a newer upload receipt.
  let checkpointQueue = Promise.resolve();
  let firstError = null;
  const checkpoint = () => {
    const snapshot = { ...next, issueDrafts: entries.map(photo => ({ ...photo })) };
    const progress = { completedFiles: ++completedFiles, totalFiles, percent: totalFiles ? Math.round(completedFiles / totalFiles * 100) : 100 };
    checkpointQueue = checkpointQueue.then(() => onProgress(snapshot, progress));
    return checkpointQueue;
  };

  async function uploadPhoto(i) {
    const p = entries[i];
    const fields = [
      ["sourceOriginalImagePath", "inspection-originals", "localOriginalImagePath"],
      ["imagePath", "inspection-images", "localImagePath"],
      ["annotatedImagePath", "inspection-annotated-images", "localAnnotatedImagePath"]
    ];
    try {
      for (const [field, folder, localField] of fields) {
        if (firstError) break;
        if (p[field] && !p[field].startsWith("cloud://")) {
          const local = p[field];
          const revision = field === "annotatedImagePath"
            ? (p.annotationRevision || 1)
            : (p.mediaRevision || 1);
          p[field] = await uploadUserFile(local, folder, `${p.id || i}.png`, {
            stableKey: `${p.id || i}-${revision}-${field}`
          });
          p[localField] = local;
          await checkpoint();
        }
      }
      if (!firstError && p.voiceFilePath && !p.voiceStorageFileId) {
        p.voiceStorageFileId = await uploadUserFile(p.voiceFilePath, "inspection-audio", `${p.id || i}.mp3`, {
          stableKey: `${p.id || i}-${p.mediaRevision || 1}-voice`
        });
        p.voiceFileId = p.voiceStorageFileId;
        await checkpoint();
      }
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(Number(concurrency) || 3), entries.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!firstError) {
      const index = cursor++;
      if (index >= entries.length) return;
      await uploadPhoto(index);
    }
  }));
  await checkpointQueue;
  if (firstError) throw firstError;

  next.images = next.issueDrafts.map(p => p.imagePath).filter(Boolean);
  return next;
}
module.exports = { keepLocalFile, uploadDraftMedia };
