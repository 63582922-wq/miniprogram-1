/**
 * 巡查草稿在本地存储中的形状定义 —— 唯一来源。
 *
 * 为什么单独抽出来：
 * 巡查创建页把草稿存成 { form, returnContext }，而标注页却按
 * snapshot.issueDrafts 去读扁平结构，永远取不到值，于是「点击照片进入标注」
 * 必然提示「照片草稿不存在」——这个功能一直是坏的。
 *
 * 根因是两个页面各自约定同一份数据结构的形状。现在形状只在
 * 这里定义，读写都必须走下面的函数。
 *
 * 存储形状：
 * {
 *   form: { projectId, projectName, title, note, issueDrafts: [...] },
 *   returnContext: { ... } | null
 * }
 */

const DRAFT_FORM_KEYS = ["projectId", "projectName", "title", "note", "issueDrafts"];
function currentOwner() {
  try { return getApp().globalData.userInfo.openId || ""; } catch (_) { return ""; }
}
function indexKey() { return "inspectionDraftIndexV3:" + currentOwner(); }
function listDrafts(projectId) {
  const entries = wx.getStorageSync(indexKey()) || [];
  return entries.filter(d => (!projectId || d.projectId === projectId) && readDraft(d.sessionKey).form)
    .sort((a,b) => b.updatedAt-a.updatedAt);
}

/** 组装要写入本地存储的草稿快照 */
function createDraftSnapshot(form = {}, returnContext = null, previous = {}) {
  return {
    ...previous,
    schemaVersion: 3,
    phase: previous.phase || "capture",
    inputVersion: previous.inputVersion || 1,
    updatedAt: Date.now(),
    form: form || {},
    returnContext: returnContext || null
  };
}

/**
 * 从快照中取出 form。
 * 兼容早期直接存扁平 form 的草稿，避免升级后旧草稿全部失效。
 */
function extractDraftForm(snapshot) {
  if (!snapshot) {
    return null;
  }
  if (snapshot.form && typeof snapshot.form === "object") {
    return snapshot.form;
  }
  // 旧格式：本身就是 form
  const looksLikeForm = DRAFT_FORM_KEYS.some((key) => Object.prototype.hasOwnProperty.call(snapshot, key));
  return looksLikeForm ? snapshot : null;
}

/** 从快照中取出 returnContext */
function extractDraftReturnContext(snapshot) {
  if (!snapshot) {
    return null;
  }
  if (snapshot.form && typeof snapshot.form === "object") {
    return snapshot.returnContext || null;
  }
  return snapshot.returnContext || null;
}

/**
 * 读草稿。返回 { form, returnContext }，不存在时 form 为 null。
 * 所有需要读草稿的地方都应使用本函数，不要直接读 storage。
 */
function readDraft(sessionKey) {
  if (!sessionKey) {
    return { form: null, returnContext: null };
  }
  let snapshot = null;
  try {
    snapshot = wx.getStorageSync(sessionKey);
  } catch (error) {
    console.error("[inspection-draft] 读取草稿失败", error);
    return { form: null, returnContext: null };
  }
  if (snapshot && ((snapshot.ownerId && snapshot.ownerId !== currentOwner()) || (currentOwner() && !snapshot.ownerId))) {
    return {form:null,returnContext:null};
  }
  return {
    ...(snapshot || {}),
    form: extractDraftForm(snapshot),
    returnContext: extractDraftReturnContext(snapshot)
  };
}

/**
 * 写草稿。统一走这里，保证形状不会被某个页面写歪。
 */
function writeDraft(sessionKey, form, returnContext, patch = {}) {
  if (!sessionKey) {
    return;
  }
  const previous = wx.getStorageSync(sessionKey) || {};
  if (previous.ownerId && previous.ownerId !== currentOwner()) throw new Error("此草稿属于其他账号");
  const changed = inputSignature(previous.form) !== inputSignature(form);
  const metadata = { ...previous, ...patch, ownerId: currentOwner(), sessionId: sessionKey };
  if (changed && previous.form) {
    if (previous.submission && previous.submission.requestId) throw new Error("这份记录正在提交，请先继续完成报告；提交内容已锁定，避免重复或错配");
    metadata.inputVersion = (previous.inputVersion || 1) + 1;
    metadata.taskId = "";
    metadata.analysisRequestId = "";
    // Keep human edits when evidence/annotation changes. Only intentionally removed photos
    // remove their associated issues; a transport upload never invalidates review.
    if (metadata.review) {
      const ids = new Set((form.issueDrafts || []).map(p => p.id));
      metadata.review = { ...metadata.review, stale: true,
        items: (metadata.review.items || []).filter(i => !i.sourcePhotoId || ids.has(i.sourcePhotoId)) };
    }
    metadata.phase = "capture";
  }
  const snapshot = createDraftSnapshot(form, returnContext, metadata);
  wx.setStorageSync(sessionKey, snapshot);
  if ((form.issueDrafts || []).length || form.title || form.note) {
    const entry = {
      sessionKey, phase: snapshot.phase, projectId: form.projectId,
      projectName: form.projectName, title: form.title,
      issueCount: (form.issueDrafts || []).length, updatedAt: snapshot.updatedAt
    };
    const entries = wx.getStorageSync(indexKey()) || [];
    wx.setStorageSync(indexKey(), [entry, ...entries.filter(d => d.sessionKey !== sessionKey)]);
  }
  return snapshot;
}

// Legacy bytes remain untouched until ownership has been checked by the entry flow.
function claimLegacyDraft(sessionKey, projectId) {
  const raw = wx.getStorageSync(sessionKey);
  const form = extractDraftForm(raw);
  if (!currentOwner() || !form || form.projectId !== projectId || raw.ownerId) return false;
  writeDraft(sessionKey, form, extractDraftReturnContext(raw));
  return true;
}

// Transport paths and transient UI state do not constitute a new analysis input.
function inputSignature(form = {}) {
  return JSON.stringify({ projectId: form.projectId, title: form.title, note: form.note,
    photos: (form.issueDrafts || []).map(p => ({ id: p.id, revision: p.mediaRevision || 1,
      annotations: p.annotations || [], voiceText: p.voiceText || "" })) });
}

function patchDraft(sessionKey, patch) {
  const draft = readDraft(sessionKey);
  if (!draft.form) throw new Error("草稿不存在，请返回现场记录");
  return writeDraft(sessionKey, draft.form, draft.returnContext, patch);
}

function finishDraft(sessionKey) {
  if (!sessionKey) return;
  wx.setStorageSync(sessionKey + ":complete", true);
  wx.removeStorageSync(sessionKey);
  wx.setStorageSync(indexKey(), (wx.getStorageSync(indexKey()) || []).filter(d => d.sessionKey !== sessionKey));
  const latest = wx.getStorageSync("latestInspectionDraftMeta");
  if (latest && latest.sessionKey === sessionKey) wx.removeStorageSync("latestInspectionDraftMeta");
}

/**
 * 局部更新某一条问题草稿，返回更新后的完整 form。
 * 标注页回写走这个接口，避免它自己拼一份形状不对的数据。
 */
function updateIssueDraft(sessionKey, issueId, patch = {}) {
  const { form, returnContext } = readDraft(sessionKey);
  if (!form || !(form.issueDrafts || []).some(item => item.id === issueId)) {
    return null;
  }

  const issueDrafts = (form.issueDrafts || []).map((item) => {
    if (item.id !== issueId) {
      return item;
    }
    return Object.assign({}, item, patch);
  });

  const nextForm = Object.assign({}, form, { issueDrafts });
  writeDraft(sessionKey, nextForm, returnContext);
  return nextForm;
}

module.exports = {
  createDraftSnapshot,
  extractDraftForm,
  extractDraftReturnContext,
  readDraft,
  writeDraft,
  updateIssueDraft,
  patchDraft, finishDraft, inputSignature, listDrafts, currentOwner, claimLegacyDraft
};
