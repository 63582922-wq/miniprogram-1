/**
 * 写操作的统一反馈封装。
 *
 * 静默失败是这个项目反复出现的一类问题：保存项目、保存待办、上传 Logo、
 * 各处删除，全都是 await 一个写操作却不捕获异常。失败时界面毫无反应，
 * 用户以为成功了继续往下做，数据就丢了 —— 「保存项目点了一点反应都没有」
 * 就是这么来的。
 *
 * 与其逐个补漏，不如让所有写操作走同一个入口：
 * 有 loading、有成功提示、失败时弹出可读的错误。
 *
 * 用法：
 *   await runWithFeedback(
 *     { loading: "删除中", success: "已删除", errorTitle: "删除失败" },
 *     () => deleteProject(projectId)
 *   );
 *
 * 任务抛错时会返回 null（默认不重新抛出），调用方据此决定是否刷新列表。
 */
async function runWithFeedback(options, task) {
  const {
    loading = "",
    success = "",
    errorTitle = "操作失败",
    rethrow = false
  } = options || {};

  if (typeof task !== "function") {
    throw new Error("runWithFeedback 需要一个任务函数");
  }

  if (loading) {
    wx.showLoading({
      title: loading,
      mask: true
    });
  }

  try {
    const result = await task();

    if (loading) {
      wx.hideLoading();
    }
    if (success) {
      wx.showToast({
        title: success,
        icon: "success"
      });
    }
    return result;
  } catch (error) {
    if (loading) {
      wx.hideLoading();
    }

    console.error("[feedback] 写操作失败", error);

    // 用 showModal 而不是 toast：toast 会自动消失，
    // 用户很可能没看到，于是继续以为操作成功了。
    wx.showModal({
      title: errorTitle,
      content: (error && error.message) || "请检查网络后重试",
      showCancel: false,
      confirmText: "知道了"
    });

    if (rethrow) {
      throw error;
    }
    return null;
  }
}

module.exports = {
  runWithFeedback
};
