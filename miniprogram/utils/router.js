function to(url) {
  return wx.navigateTo({ url });
}

function replace(url) {
  return wx.redirectTo({ url });
}

function encodeReturnContext(context) {
  if (!context) {
    return "";
  }
  try {
    return encodeURIComponent(JSON.stringify(context));
  } catch (error) {
    return "";
  }
}

function decodeReturnContext(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch (error) {
    return null;
  }
}

function navigateBackOrOpen(route, url) {
  const pages = getCurrentPages();
  const targetIndex = pages.map((page) => `/${page.route}`).lastIndexOf(route);
  if (targetIndex >= 0) {
    const delta = pages.length - 1 - targetIndex;
    if (delta > 0) {
      return wx.navigateBack({ delta });
    }
  }
  return wx.redirectTo({ url });
}

function returnToContext(context) {
  if (!context || !context.returnTarget) {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      return wx.navigateBack({ delta: 1 });
    }
    return wx.switchTab({ url: "/pages/project/list/index" });
  }

  if (context.returnTarget === "projectDetail" && context.projectId) {
    return navigateBackOrOpen(
      "/pages/project/detail/index",
      `/pages/project/detail/index?projectId=${context.projectId}`
    );
  }

  if (context.returnTarget === "inspectionList" && context.projectId) {
    return navigateBackOrOpen(
      "/pages/inspection/list/index",
      `/pages/inspection/list/index?projectId=${context.projectId}&projectName=${encodeURIComponent(context.projectName || "")}`
    );
  }

  if (context.returnTarget === "reportList" && context.projectId) {
    wx.setStorageSync("pendingReportContext", {
      projectId: context.projectId,
      projectName: context.projectName || "",
      source: context.source || ""
    });
    return wx.switchTab({
      url: "/pages/report/list/index"
    });
  }

  return wx.navigateBack({ delta: 1 });
}

module.exports = {
  to,
  replace,
  encodeReturnContext,
  decodeReturnContext,
  returnToContext
};
