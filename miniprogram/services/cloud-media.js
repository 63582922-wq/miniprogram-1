const CLOUD_FILE_PREFIX = "cloud://";
const MAX_TEMP_URL_BATCH_SIZE = 50;

function isCloudFileId(value) {
  return typeof value === "string" && value.startsWith(CLOUD_FILE_PREFIX);
}

/** Resolve cloud IDs only for display; business records keep the immutable file IDs. */
async function resolveCloudFileUrls(fileIds = []) {
  const ids = Array.from(new Set((fileIds || []).filter(isCloudFileId)));
  const urls = {};
  const failed = [];
  if (!ids.length) return {urls, failed};

  const cloudApi = typeof wx !== "undefined" && wx.cloud;
  if (!cloudApi || typeof cloudApi.getTempFileURL !== "function") {
    return {urls, failed:ids};
  }

  for (let offset = 0; offset < ids.length; offset += MAX_TEMP_URL_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MAX_TEMP_URL_BATCH_SIZE);
    try {
      const result = await cloudApi.getTempFileURL({fileList:batch});
      const files = result && result.fileList || [];
      batch.forEach((id, index) => {
        const file = files.find(item => item.fileID === id) || files[index] || {};
        if (file.tempFileURL && (file.status === undefined || file.status === 0)) urls[id] = file.tempFileURL;
        else failed.push(id);
      });
    } catch (_error) {
      failed.push(...batch);
    }
  }
  return {urls, failed};
}

module.exports = {isCloudFileId, resolveCloudFileUrls};
