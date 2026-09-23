const { listDrafts, claimLegacyDraft } = require("./inspection-draft");
const { getProjectDetail } = require("../services/project");
const { encodeReturnContext } = require("./router");

async function openRecord(projectId, projectName, returnTarget = "projectDetail") {
  if (!projectId) throw new Error("请先选择项目");
  const app = getApp();
  if (app.ensureReady) await app.ensureReady();
  const verified = await getProjectDetail(projectId);
  if (!verified.project || verified.project._id !== projectId) throw new Error("项目不存在或无权限");
  const legacy = wx.getStorageSync("latestInspectionDraftMeta");
  if (legacy && legacy.projectId === projectId && !listDrafts(projectId).some(d=>d.sessionKey===legacy.sessionKey)) {
    const raw=wx.getStorageSync(legacy.sessionKey);
    if(raw && !raw.ownerId){
      const choice=await new Promise(resolve=>wx.showModal({title:"恢复旧版记录？",content:`发现“${projectName}”的旧版草稿。确认它属于当前账号后，可保留原内容继续编辑。`,confirmText:"确认恢复",cancelText:"暂不恢复",success:resolve,fail:()=>resolve({confirm:false})}));
      if(choice.confirm)claimLegacyDraft(legacy.sessionKey,projectId);
    }
  }
  const drafts = listDrafts(projectId);
  let sessionKey = "";
  if (drafts.length) {
    const choice = await new Promise(resolve => wx.showActionSheet({
      itemList: ["新建记录（保留已有草稿）", ...drafts.slice(0,5).map(d =>
        `继续 · ${d.issueCount} 张照片 · ${new Date(d.updatedAt).toLocaleString()}`)],
      success: resolve, fail: () => resolve(null)
    }));
    if (!choice) return;
    if (choice.tapIndex > 0) sessionKey = drafts[choice.tapIndex-1].sessionKey;
  }
  const context = encodeReturnContext({projectId,projectName,returnTarget});
  wx.navigateTo({url: `/pages/inspection/create/index?projectId=${encodeURIComponent(projectId)}&returnContext=${context}${sessionKey ? "&sessionKey="+encodeURIComponent(sessionKey) : ""}`});
}
module.exports = {openRecord};
