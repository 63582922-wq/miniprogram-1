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

/** 组装要写入本地存储的草稿快照 */
function createDraftSnapshot(form = {}, returnContext = null) {
  return {
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
  return {
    form: extractDraftForm(snapshot),
    returnContext: extractDraftReturnContext(snapshot)
  };
}

/**
 * 写草稿。统一走这里，保证形状不会被某个页面写歪。
 */
function writeDraft(sessionKey, form, returnContext) {
  if (!sessionKey) {
    return;
  }
  wx.setStorageSync(sessionKey, createDraftSnapshot(form, returnContext));
}

/**
 * 局部更新某一条问题草稿，返回更新后的完整 form。
 * 标注页回写走这个接口，避免它自己拼一份形状不对的数据。
 */
function updateIssueDraft(sessionKey, issueId, patch = {}) {
  const { form, returnContext } = readDraft(sessionKey);
  if (!form) {
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
  updateIssueDraft
};
