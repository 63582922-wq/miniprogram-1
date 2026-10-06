function identity(prefix = "item") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
function isNumberedAnnotation(annotation = {}) {
  return annotation.type === "point" || ((annotation.type === "box" || annotation.type === "ellipse") && annotation.numbered === true);
}
function getPhotoDisplayPath(photo = {}) {
  // Cloud file IDs are canonical persistence references, but the mini-program
  // image component needs a local path during capture/review. Uploaded drafts
  // retain local*Path explicitly for this purpose.
  const annotatedPath = photo.localAnnotatedImagePath ||
    (photo.annotatedImagePath && !String(photo.annotatedImagePath).startsWith("cloud://") ? photo.annotatedImagePath : "");
  // Prefer the marked rendition even when it is already a cloud ID. The
  // caller resolves cloud IDs to a temporary display URL before rendering.
  return annotatedPath || photo.annotatedImagePath || photo.localImagePath || photo.imagePath || "";
}
function bindIssues(items = [], photos = []) {
  return items.map((item, i) => {
    const source = item.sourcePhotoId ? photos.find(p => p.id === item.sourcePhotoId) : photos[item.sourceIndex];
    return { ...item, id: item.id || identity("issue"),
      sourcePhotoId: source ? source.id : (item.sourcePhotoId || ""),
      sourceIndex: source ? photos.indexOf(source) : (item.sourceIndex ?? i) };
  });
}
function buildManualReviewItems(issueDrafts = []) {
  return (issueDrafts || []).flatMap((photo, sourceIndex) => {
    const text = `${photo.voiceText || ""}`.trim();
    const clauses = text.split(/[；;。！？\n]+/).map(value=>value.trim()).filter(Boolean);
    // Point markers and problem rows share saved order. annotationId is the
    // durable relationship; markerNumber is the reader-facing label.
    const markers = (photo.annotations || []).filter(isNumberedAnnotation);
    const count = Math.max(markers.length, clauses.length, text ? 1 : 0);
    return Array.from({length:count},(_,index)=>({
      id:identity("issue"),
      sourcePhotoId:photo.id,
      sourceIndex,
      subIssueIndex:index+1,
      annotationId:markers[index]?.id || "",
      markerNumber:markers[index] ? index+1 : 0,
      description:clauses[index] || (count===1 ? text : ""),
      suggestion:"",
      severity:"normal",
      responsibleParty:"pending"
    }));
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
module.exports = { identity, bindIssues, buildManualReviewItems, resolveIssueMedia, getPhotoDisplayPath, isNumberedAnnotation };
