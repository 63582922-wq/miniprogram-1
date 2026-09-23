function identity(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function bindIssues(items = [], photos = []) {
  return items.map((item, i) => {
    const source = item.sourcePhotoId ? photos.find(p => p.id === item.sourcePhotoId) : photos[item.sourceIndex];
    return { ...item, id: item.id || identity("issue"),
      sourcePhotoId: source ? source.id : (item.sourcePhotoId || ""),
      sourceIndex: source ? photos.indexOf(source) : (item.sourceIndex ?? i) };
  });
}
function resolveIssueMedia(items = [], photos = []) {
  return bindIssues(items, photos).map(item => {
    const p = photos.find(p => p.id === item.sourcePhotoId);
    if (!p) throw new Error("问题来源照片不存在，请返回核对");
    return { ...item, images: [p.imagePath], annotatedImages: [p.annotatedImagePath || p.imagePath],
      annotations: p.annotations || [], voiceStorageFileId: p.voiceStorageFileId || "", voiceText: p.voiceText || "" };
  });
}
module.exports = { identity, bindIssues, resolveIssueMedia };
