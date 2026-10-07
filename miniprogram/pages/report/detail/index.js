const { getReportDetail, buildReportData } = require("../../../services/report");
const { isCloudFileId, resolveCloudFileUrls } = require("../../../services/cloud-media");
const { buildReportNo: formatReportNo } = require("../../../utils/report-identity");
const { mapResponsiblePartyText, formatDateTime, usesEditorialTypeface } = require("../../../utils/format");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");
const { getWindowInfo } = require("../../../utils/system");
const { createReportShareToken, revokeReportShareToken } = require("../../../services/report");

/** 严重度：由重到轻，用于摘要卡与分布条的固定顺序 */
const SEVERITY_KEYS = ["critical", "major", "normal"];
const SEVERITY_LABELS = { critical: "严重", major: "较重", normal: "一般" };
const formatPercent = value => `${Number(Number(value).toFixed(4))}%`;

/**
 * 统计各严重度的数量。
 *
 * 读者打开报告的第一个问题是「几个问题、几个严重、什么时候改完」，
 * 所以摘要必须在首屏，不能让人自己数。
 */
function buildSeverityStats(items = []) {
  const counts = { critical: 0, major: 0, normal: 0 };
  items.forEach((item) => {
    const key = SEVERITY_KEYS.includes(item.severity) ? item.severity : "normal";
    counts[key] += 1;
  });

  const total = items.length;
  const percent = (n) => (total ? Math.round((n / total) * 100) : 0);

  return {
    total,
    critical: counts.critical,
    major: counts.major,
    normal: counts.normal,
    criticalPercent: percent(counts.critical),
    majorPercent: percent(counts.major),
    normalPercent: percent(counts.normal)
  };
}

/** 一句话结论：把摘要翻译成一句能直接读给对方听的话 */
function buildConclusion(stats) {
  if (!stats.total) {
    return "本次未记录问题，不代表工程验收合格。";
  }
  const parts = [`本次已确认 ${stats.total} 项问题`];
  if (stats.critical) {
    parts.push(`其中严重 ${stats.critical} 项，建议优先处理`);
  } else if (stats.major) {
    parts.push(`其中较重 ${stats.major} 项`);
  }
  return `${parts.join("，")}。`;
}

/**
 * 报告编号。
 *
 * 现场复验、整改回执、对账都靠它指代「哪一份报告」。
 * 用生成日期 + 文档 ID 尾段，稳定且可读。
 */
// Keep a local wrapper so the page display helpers remain directly testable;
// the format itself is shared with the report list.
function buildReportNo(report = {}) { return formatReportNo(report); }

/**
 * 首屏「需要优先处理」清单。
 *
 * 报告按照片顺序一路排下去，严重项会混在长列表里，接收者要自己找。
 * 这里把非一般的条目提到概览下方，点一下就跳到对应照片分组。
 * 只做导航，不改写任何内容——清单里的文字就是问题本身。
 */
function buildPriorityItems(issueGroups = []) {
  const items = [];
  // 概览要能一眼扫完；完整描述就在下面同一页，点一下即到，所以这里只留引子。
  const PREVIEW_LIMIT = 42;
  const preview = text => {
    const value = `${text || ""}`.trim();
    return value.length > PREVIEW_LIMIT ? `${value.slice(0, PREVIEW_LIMIT)}…` : value;
  };
  issueGroups.forEach((group, groupIndex) => {
    (group.issues || []).forEach(issue => {
      if (!issue || issue.severity === "normal" || !issue.severity) return;
      items.push({
        key: `${groupIndex}-${issue.displayNo}`,
        groupIndex,
        severity: issue.severity,
        severityText: issue.severityText || "",
        groupTitle: group.groupTitle || "",
        displayNo: issue.displayNo || "",
        description: preview(issue.description)
      });
    });
  });
  // 严重优先于较重，其余保持报告内的原始顺序。
  const rank = { critical: 0, major: 1 };
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => (rank[a.item.severity] - rank[b.item.severity]) || (a.order - b.order))
    .map(entry => entry.item);
}

function normalizeReportSummary(report = {}) {
  const summary = typeof report.summary === "string" ? report.summary.trim() : "";
  if (!summary || report.summarySource === "inspector") return summary;

  // Older snapshots may contain the former generated count sentence. The
  // overview already presents that count, while the group labels show scope.
  // Hide the whole generated sentence rather than surfacing a boilerplate
  // "summary" that repeats information and was never written by the inspector.
  const generatedSummary = summary.match(/^本次记录\s*\d+\s*个问题项?[。.!！]?\s*(记录仅覆盖(?:所)?拍照片与现场说明[，,]\s*不代表工程验收合格[。.!！]?)?$/);
  return generatedSummary ? "" : summary;
}

/**
 * 按照片分组并编号。
 *
 * 新报告按稳定照片 ID 分组：照片 01 / 02 / 03 是证据顺序，照片下的
 * 1. / 2. / 3. 是该照片内的问题顺序；有标注时，markerNumber 与照片
 * 渲染图上的编号一一对应。不能把“问题一”当成照片编号，否则接收者会
 * 把照片顺序和问题顺序混为一谈。
 * 旧报告无法确定来源关系时保留原来的图片分组与顺序。
 */
function buildIssueGroups(items = [], photos = []) {
  const groups = [];
  const map = new Map();
  const registerPhotoAliases = (photo, group, index) => {
    [photo.id, photo.photoId, photo.mediaId, photo.imagePath, photo.annotatedImagePath]
      .filter(value => typeof value === "string" && value)
      .forEach(value => {
        if (!map.has(value)) map.set(value, group);
        else if (map.get(value) !== group) map.set(value, null);
      });
    // Positional aliases are legacy fallbacks. Never overwrite a real stable
    // photo ID such as "photo-1" with an alias from a later row.
    if (!map.has(`photo-${index}`)) map.set(`photo-${index}`, group);
    if (!map.has(`source-${index}`)) map.set(`source-${index}`, group);
  };
  photos.forEach((p,i)=>{
    const key = [p.id, p.photoId, p.mediaId, p.imagePath, p.annotatedImagePath]
      .find(value => typeof value === "string" && value) || `photo-${i}`;
    const g={key,sourceIndex:p.sourceIndex??i,image:"",originalImage:p.imagePath||"",annotatedImage:p.annotatedImagePath||"",annotations:Array.isArray(p.annotations)?p.annotations:[],caption:p.caption||"",issues:[]};
    groups.push(g);
    registerPhotoAliases(p, g, i);
  });

  items.forEach((item, index) => {
    const primaryImage = (item.annotatedImages && item.annotatedImages[0])
      || (item.images && item.images[0])
      || "";
    const sourceIndex = Number.isInteger(item.sourceIndex) ? item.sourceIndex : index;
    // Only an explicitly persisted sourceIndex can bind to source-N. The item
    // array position is not evidence of photo ownership in legacy snapshots.
    const key = item.sourcePhotoId || primaryImage || (Number.isInteger(item.sourceIndex) ? `source-${item.sourceIndex}` : `legacy-${index}`);

    const hasAlias = map.has(key);
    const matchedGroup = hasAlias ? map.get(key) : undefined;
    if (matchedGroup === null) {
      // A repeated legacy path is ambiguous. Keep the issue visible in its
      // own unresolved group; never attach it silently to either photo.
      const group = {
        key: `legacy-unresolved-${index}`,
        sourceIndex,
        image: primaryImage,
        issues: [],
        sourceAmbiguous: true
      };
      groups.push(group);
      group.issues.push(Object.assign({}, item, {
        severity: SEVERITY_KEYS.includes(item.severity) ? item.severity : "normal",
        severityText: SEVERITY_LABELS[item.severity] || "一般",
        responsibleText: item.responsiblePartyName || (item.responsibleParty && item.responsibleParty !== 'pending' ? mapResponsiblePartyText(item.responsibleParty) : ''),
        timeText: formatDateTime(item.createdAt) || ""
      }));
      return;
    }
    if (!matchedGroup) {
      const group = {
        key,
        sourceIndex,
        image: primaryImage,
        issues: [],
        sourceAmbiguous: true
      };
      map.set(key, group);
      groups.push(group);
    }

    const group = map.get(key);
    group.issues.push(Object.assign({}, item, {
      // 归一化严重度：模板里要拼 class，未填时会拼出 --undefined
      severity: SEVERITY_KEYS.includes(item.severity) ? item.severity : "normal",
      severityText: SEVERITY_LABELS[item.severity] || "一般",
      responsibleText: item.responsiblePartyName || (item.responsibleParty && item.responsibleParty !== 'pending' ? mapResponsiblePartyText(item.responsibleParty) : ''),
      timeText: formatDateTime(item.createdAt) || ""
    }));
  });

  if(photos.length)groups.sort((a, b) => a.sourceIndex - b.sourceIndex);

  groups.forEach((group, groupIndex) => {
    // 编号标注必须有对应问题文字才有意义。零问题照片保留原图，
    // 避免出现“0 项问题”但图上孤零零一个编号、读者无从对应。
    // 可编辑标注和渲染图仍保留在报告快照中，没有删除历史数据。
    group.image = group.issues.length
      ? (group.annotatedImage || group.image || group.originalImage)
      : (group.originalImage || group.image || group.annotatedImage);
    // 一级永远是照片顺序；是否有问题只作为右侧状态，不改变照片编号。
    group.groupTitle = `照片 ${String(groupIndex + 1).padStart(2, "0")}${group.sourceAmbiguous ? " · 来源待确认" : ""}`;
    group.groupStatus = group.issues.length ? `${group.issues.length} 项问题` : "未记录问题";

    group.issues.sort((left, right) => {
      const a = left.markerNumber || left.subIssueIndex || left.originalIndex || 0;
      const b = right.markerNumber || right.subIssueIndex || right.originalIndex || 0;
      return a - b;
    });
    // Older immutable reports stored the speech transcript as the photo
    // caption as well as publishing its organized issue text. Keep the stored
    // snapshot untouched, but avoid showing the same sentence twice. Distinct
    // inspector-authored photo notes remain visible.
    const compactText = value => `${value || ""}`.replace(/[\s，。；：、,.!?！？:;]+/g, "");
    const captionText = compactText(group.caption);
    if (captionText && group.issues.some(issue => {
      const description = compactText(issue.description);
      return description && (captionText === description ||
        (description.length >= 8 && captionText.includes(description)) ||
        (captionText.length >= 8 && description.includes(captionText)));
    })) group.caption = "";
    group.issues.forEach((issue, issueIndex) => {
      const number = issue.markerNumber || issue.subIssueIndex || issueIndex + 1;
      issue.displayNo = `${number}.`;
      const pointAnnotations=(group.annotations||[]).filter(annotation => annotation.type === "point" || ((annotation.type === "box" || annotation.type === "ellipse") && annotation.numbered === true));
      const shape = issue.annotationId
        ? (group.annotations||[]).find(annotation => annotation.id === issue.annotationId)
        : pointAnnotations[Number(issue.markerNumber || 0) - 1];
      const point = shape && (shape.type === "point" || ((shape.type === "box" || shape.type === "ellipse") && shape.numbered === true)) && shape.a;
      issue.markerPoint = point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? {x:Math.max(0,Math.min(1,point.x)),y:Math.max(0,Math.min(1,point.y)),left:`${Math.max(0,Math.min(1,point.x))*100}%`,top:`${Math.max(0,Math.min(1,point.y))*100}%`}
        : null;
      issue.markerLabel = issue.markerNumber
        ? (issue.markerPoint ? `照片标注 ${issue.markerNumber}` : `照片标注 ${issue.markerNumber} · 位置数据缺失`)
        : "未标注位置";
    });
    group.markers = group.issues.filter(issue => issue.markerNumber && issue.markerPoint).map(issue => ({
      key:issue.id || `${group.key}-${issue.displayNo}`,
      number:issue.markerNumber,
      x:issue.markerPoint.x,
      y:issue.markerPoint.y,
      left:issue.markerPoint.left,
      top:issue.markerPoint.top
    }));
    group.issues.forEach(issue=>{issue.viewerKey=issue.id || `${group.key}-${issue.displayNo}`;});
    group.mappingText = group.issues.length && group.issues.every(issue => Number(issue.markerNumber) > 0 && issue.markerPoint)
      ? "照片标注号与下方同号问题一一对应"
      : "问题按本照片内顺序编号；未标注位置或缺少坐标的问题会明确说明";
  });

  return groups;
}


function getErrorMessage(error, fallback = "未知错误") {
  if (!error) {
    return fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error.message) {
    return error.message;
  }
  if (error.errMsg) {
    return error.errMsg;
  }
  try {
    return JSON.stringify(error);
  } catch (_error) {
    return fallback;
  }
}

function buildReportDisplayState(report = {}) {
  const issueGroups = buildIssueGroups(report.items || [], report.photos || []);
  // 报告的“照片数”必须按快照中的照片口径计算，而不是按问题条目计算。
  // 同一张照片可以有多个问题，零问题照片也必须计入本次范围；旧报告没有
  // photos 时才回退到由问题建立的分组，避免历史数据的首屏范围显示失真。
  const photoCount = Array.isArray(report.photos) && report.photos.length
    ? report.photos.length
    : issueGroups.length;
  const identityRows = [{ label: "报告编号", value: buildReportNo(report) }];
  const inspectorName = typeof report.inspectorName === "string" ? report.inspectorName.trim() : "";
  const publisherName = typeof report.publisherName === "string" ? report.publisherName.trim() : "";
  const projectAddress = typeof report.projectAddress === "string" ? report.projectAddress.trim() : "";
  const companyAddress = typeof report.companyAddress === "string" ? report.companyAddress.trim() : "";
  if (inspectorName) identityRows.push({
    label: publisherName && publisherName === inspectorName ? "巡查人 / 发布人" : "巡查人",
    value: inspectorName
  });
  if (projectAddress) identityRows.push({ label: "项目位置", value: projectAddress });
  // 甲方是项目自带信息，报告要发给施工方与业主双方，写清楚这活是谁的。
  const clientName = typeof report.clientName === "string" ? report.clientName.trim() : "";
  const clientPhone = typeof report.clientPhone === "string" ? report.clientPhone.trim() : "";
  if (clientName || clientPhone) {
    identityRows.push({ label: "甲方", value: [clientName, clientPhone].filter(Boolean).join("　") });
  }
  // The issuer's registered/contact address is useful when it differs from
  // the inspected site; suppress it when identical to avoid repeating a row.
  if (companyAddress && companyAddress !== projectAddress) {
    identityRows.push({ label: "单位地址", value: companyAddress });
  }
  if (publisherName && publisherName !== inspectorName) identityRows.push({ label: "报告发布人", value: publisherName });

  // Several roles can intentionally share one company phone. Show one contact
  // target with combined role labels, rather than repeating the same number.
  const contactRoles = new Map();
  [
    ["单位", report.companyPhone],
    ["巡查人", report.inspectorPhone],
    ["发布人", report.publisherPhone]
  ].forEach(([role, rawPhone]) => {
    const phone = typeof rawPhone === "string" ? rawPhone.trim() : "";
    if (!phone) return;
    if (!contactRoles.has(phone)) contactRoles.set(phone, []);
    if (!contactRoles.get(phone).includes(role)) contactRoles.get(phone).push(role);
  });
  const contactEntries = Array.from(contactRoles, ([phone, roles]) => ({
    phone,
    label: roles.length > 1 ? "统一联系电话" : roles[0]
  }));

  // 首屏清单只列最要紧的几条；把「严重」写满全表等于没有重点。
  const priorityAll = buildPriorityItems(issueGroups);
  const PRIORITY_LIMIT = 4;

  return {
    ...report,
    summary: normalizeReportSummary(report),
    inspectionDateDisplay: report.inspectionDateText || report.inspectionDate,
    generatedAtDisplay: formatDateTime(report.publishedAt || report.createdAt || report.generatedAt) || "",
    // 首屏需要的摘要信息：读者先看到「几个问题、几个严重」再决定要不要往下看
    reportNo: buildReportNo(report),
    severityStats: buildSeverityStats(report.items || []),
    conclusion: buildConclusion(buildSeverityStats(report.items || [])),
    identityRows,
    contactEntries,
    issueGroups,
    priorityItems: priorityAll.slice(0, PRIORITY_LIMIT),
    priorityOmitted: Math.max(0, priorityAll.length - PRIORITY_LIMIT),
    photoCount
  };
}

/**
 * 顶部固定头部的实际占位高度 —— 状态栏 + 导航栏。
 *
 * 只算导航栏是不够的：page-nav-bar 会额外渲染一条状态栏高度的占位。
 * 实测机型状态栏 54 + 导航 44 = 98；只减 44 会让跳转目标正好被压在
 * 导航下（分组标题藏在栏后，屏幕顶部直接是照片）。
 */
function fixedHeaderHeight() {
  const system = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : {};
  const statusBarHeight = system.statusBarHeight || 20;
  let navHeight = 44;
  try {
    const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
      ? wx.getMenuButtonBoundingClientRect()
      : null;
    if (capsule && capsule.height) {
      navHeight = Math.max(44, Math.round((capsule.top - statusBarHeight) * 2 + capsule.height));
    }
  } catch (_error) {
    // Runtimes without a capsule rect keep the standard navigation height.
  }
  return statusBarHeight + navHeight;
}

Page({
  data: {
    reportId: "",
    inspectionId: "",
    /** 收件人从分享链接带过来的只读凭据 */
    shareToken: "",
    /** 报告是否由当前用户拥有；非拥有者只看只读视图 */
    isOwner: false,
    /** 分享卡片用的 https 图片地址（cloud:// 不能直接用于分享卡） */
    shareImageUrl: "",
    previewGroup:null,
    viewerStageHeight:0,
    viewerIssueHeight:0,
    viewerStatusBarHeight:20,
    viewerNavHeight:44,
    viewerCapsuleSafeWidth:112,
    viewerX:0,
    viewerY:0,
    viewerScale:1,
    returnContext: null,
    report: null,
    loading: true,
    loadError: "",
    reportTitleClass: "report-cover__title--ui",
    sharePanelOpen:false,
    sharePanelMode:"actions",
    shareChoices:[],
    shareAction:"",
    shareConfirmTitle:"",
    shareConfirmCopy:"",
    shareConfirmLabel:"",
    shareConfirmDanger:false,
    shareActionError:"",
    shareBusy:false
  },
  async onLoad(query) {
    this.reportHeaderHeight = fixedHeaderHeight();
    this.setData({
      reportId: query.reportId || "",
      inspectionId: query.inspectionId || "",
      shareToken: query.shareToken || "",
      returnContext: decodeReturnContext(query.returnContext) || null
    });
    wx.hideShareMenu();
  },
  async onShow() {
    await this.loadReport();
  },
  onUnload() {
    this.reportPreviewGeneration = (this.reportPreviewGeneration || 0) + 1;
  },
  handleBackTap() {
    returnToContext(this.data.returnContext);
  },
  handleHomeTap() {
    wx.switchTab({
      url: "/pages/project/list/index"
    });
  },
  /** 报告读者常要直接联系出具方，点一下就拨号 */
  handleCallCompany(event) {
    const phone = `${event.currentTarget.dataset.phone || ""}`.trim();
    if (!phone) {
      return;
    }
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => {}
    });
  },
  /**
   * 从首屏「需要优先处理」跳到对应照片分组。
   *
   * 用 selector 定位而不是自己算偏移：分组高度随照片比例变化，算不准。
   * 顶部有固定导航，所以定位后再回退一个导航高度，别让分组标题被压在栏下。
   */
  handleJumpToGroup(event) {
    const groupIndex = Number(event.currentTarget.dataset.group);
    if (!Number.isInteger(groupIndex) || groupIndex < 0) {
      return;
    }
    const query = wx.createSelectorQuery();
    query.select(`#photo-group-${groupIndex}`).boundingClientRect();
    query.selectViewport().scrollOffset();
    query.exec(result => {
      const rect = result && result[0];
      const viewport = result && result[1];
      if (!rect || !viewport) {
        return;
      }
      const headerHeight = this.reportHeaderHeight || 0;
      const target = Math.max(0, viewport.scrollTop + rect.top - headerHeight - 12);
      wx.pageScrollTo({ scrollTop: target, duration: 260 });
    });
  },
  /** 点图片放大看细节 —— 报告的使命就是让人看清问题 */
  handlePreviewImage(event) {
    const groupIndex = Number(event.currentTarget.dataset.index);
    const group = this.data.report && this.data.report.issueGroups && this.data.report.issueGroups[groupIndex];
    if (!group || !group.image) return;
    const system = typeof wx.getWindowInfo === "function" ? wx.getWindowInfo() : {};
    const stageWidth = system.windowWidth || 375;
    const windowHeight = system.windowHeight || 667;
    const statusBarHeight = system.statusBarHeight || 20;
    let navHeight = 44;
    let capsuleSafeWidth = 112;
    try {
      const capsule = typeof wx.getMenuButtonBoundingClientRect === "function"
        ? wx.getMenuButtonBoundingClientRect()
        : null;
      if (capsule && capsule.height) {
        navHeight = Math.max(44, Math.round((capsule.top - statusBarHeight) * 2 + capsule.height));
        capsuleSafeWidth = Math.max(112, Math.round(stageWidth - capsule.left + 16));
      }
    } catch (_error) {
      // Keep the standard mini-program navigation metrics on runtimes without a capsule rect.
    }
    const safeAreaBottom = system.safeArea && Number.isFinite(system.safeArea.bottom)
      ? Math.max(0, windowHeight - system.safeArea.bottom)
      : 0;
    const issuePanelHeight = group.issues && group.issues.length
      ? Math.min(200, Math.max(132, Math.round(windowHeight * 0.24)))
      : 0;
    const stageHeight = Math.max(260, windowHeight - statusBarHeight - navHeight - issuePanelHeight - 64 - safeAreaBottom);
    const openViewer = (imageWidth, imageHeight) => {
      const fit = Math.min(stageWidth / imageWidth, stageHeight / imageHeight);
      const width = Math.max(1, Math.round(imageWidth * fit));
      const height = Math.max(1, Math.round(imageHeight * fit));
      this.setData({
        previewGroup:{...group,viewerWidth:width,viewerHeight:height,activeIssueId:group.issues[0]?.viewerKey||""},
        viewerStageHeight:stageHeight,
        viewerIssueHeight:issuePanelHeight,
        viewerStatusBarHeight:statusBarHeight,
        viewerNavHeight:navHeight,
        viewerCapsuleSafeWidth:capsuleSafeWidth,
        viewerX:Math.round((stageWidth-width)/2),
        viewerY:Math.round((stageHeight-height)/2),
        viewerScale:1
      });
    };
    // The report load already resolves the natural photo dimensions for the
    // thumbnail and marker layout. Reuse them here so opening the viewer is
    // immediate and does not depend on a second network/file-info request.
    if (group.sourceWidth > 0 && group.sourceHeight > 0) {
      openViewer(group.sourceWidth, group.sourceHeight);
      return;
    }
    wx.getImageInfo({
      // Metadata must come from the URL already resolved for the visible
      // thumbnail. The original may still be a cloud:// file ID and fail here.
      src:group.image || group.originalImage,
      success:info=>{
        if (!info || !info.width || !info.height) {
          wx.showToast({title:"照片尺寸暂不可用，请重新加载报告",icon:"none"});
          return;
        }
        openViewer(info.width, info.height);
      },
      fail:()=>wx.showToast({title:"照片暂时无法打开，请重新加载报告",icon:"none"})
    });
  },
  closeImageViewer(){this.setData({previewGroup:null});},
  handleViewerIssueTap(event){
    const issueId=event.currentTarget.dataset.id;
    this.setData({"previewGroup.activeIssueId":issueId});
  },
  async resolveReportPreviewMedia(generation, report) {
    const logoFileId = report.logoFileId || "";
    const groups = report.issueGroups || [];
    const fileIds = Array.from(new Set([logoFileId, ...groups.flatMap(group => [group.image || "", group.originalImage || ""])]
      .filter(isCloudFileId)));
    const urls = {};
    if (logoFileId && !isCloudFileId(logoFileId)) urls[logoFileId] = logoFileId;
    const resolved = await resolveCloudFileUrls(fileIds);
    Object.assign(urls,resolved.urls);
    if (generation !== this.reportPreviewGeneration || !this.data.report || this.data.report._id !== report._id) return;
    const system=getWindowInfo();
    const pageInset=system.windowWidth*36/750;
    const thumbWidth=system.windowWidth-pageInset*2;
    const groupsWithThumbnailMarkers=await Promise.all(groups.map(async group=>{
      const image=isCloudFileId(group.image) ? (urls[group.image]||"") : group.image;
      const originalImage=isCloudFileId(group.originalImage) ? (urls[group.originalImage]||"") : (group.originalImage||image);
      if(!originalImage||!wx.getImageInfo)return {...group,image,originalImage};
      const info=await new Promise(resolve=>wx.getImageInfo({src:originalImage,success:resolve,fail:()=>resolve(null)}));
      if(!info||!info.width||!info.height)return {...group,image,originalImage};
      const thumbHeight=Math.min(thumbWidth*info.height/info.width,thumbWidth*1.25);
      const scale=Math.min(thumbWidth/info.width,thumbHeight/info.height);
      const renderedWidth=info.width*scale,renderedHeight=info.height*scale;
      const offsetX=(thumbWidth-renderedWidth)/2,offsetY=(thumbHeight-renderedHeight)/2;
      const markers=(group.markers||[]).map(marker=>({...marker,
        left:formatPercent((offsetX+marker.x*renderedWidth)/thumbWidth*100),
        top:formatPercent((offsetY+marker.y*renderedHeight)/thumbHeight*100)
      }));
      return {...group,image,originalImage,sourceWidth:info.width,sourceHeight:info.height,
        thumbnailHeight:Math.round(thumbHeight*750/system.windowWidth),markers};
    }));
    if (generation !== this.reportPreviewGeneration || !this.data.report || this.data.report._id !== report._id) return;
    this.setData({
      "report.logoPreviewUrl":logoFileId ? (urls[logoFileId] || "") : "",
      "report.logoPreviewError":Boolean(report.logoPreviewError || (logoFileId && !urls[logoFileId])),
      "report.issueGroups":groupsWithThumbnailMarkers.map(group => ({
        ...group,
        originalImage:isCloudFileId(group.originalImage) ? (urls[group.originalImage] || "") : group.originalImage,
        imagePreviewError:Boolean(group.imagePreviewError || (group.image && isCloudFileId(group.image) && !urls[group.image]))
      }))
    });
  },
  handleReportLogoPreviewError() {
    this.setData({"report.logoPreviewUrl":"","report.logoPreviewError":true});
  },
  handleReportImageError(event) {
    const index = Number(event.currentTarget.dataset.index);
    const groups = [...((this.data.report && this.data.report.issueGroups) || [])];
    if (!groups[index]) return;
    groups[index] = {...groups[index],image:"",imagePreviewError:true};
    this.setData({"report.issueGroups":groups});
  },
  async loadReport() {
    const generation = (this.reportPreviewGeneration || 0) + 1;
    this.reportPreviewGeneration = generation;
    this.setData({
      loading: true,
      loadError: "",
      shareImageUrl: ""
    });

    let report;
    try {
      if (this.data.reportId) {
        report = await getReportDetail(this.data.reportId, undefined, this.data.shareToken);
      } else if (this.data.inspectionId) {
        report = await buildReportData({
          inspectionId: this.data.inspectionId
        });
      }

      // 快速切换报告时，较早的网络响应不能覆盖当前页面。
      if (generation !== this.reportPreviewGeneration) return;

      if (report) {
        if (report._id || this.data.inspectionId) markGuideStep("reportGenerated", true);
        const displayTitle = report.projectName || report.title || "";
        const displayReport = buildReportDisplayState(report);
        displayReport.logoPreviewUrl = isCloudFileId(report.logoFileId) ? "" : (report.logoFileId || "");
        displayReport.logoPreviewError = Boolean(report.logoUnavailable);
        if(report.mediaUnavailable){
          displayReport.issueGroups=displayReport.issueGroups.map(group=>({
            ...group,
            imagePreviewError:Boolean(!group.image)
          }));
        }
        this.setData({
          report: displayReport,
          reportId: report._id || this.data.reportId,
          isOwner: report.accessMode === "owner",
          reportTitleClass: usesEditorialTypeface(displayTitle) ? "" : "report-cover__title--ui"
        });
        this.resolveReportPreviewMedia(generation, displayReport);
        if (report._id && report.shareState !== "revoked" && (report.shareToken || this.data.shareToken)) {
          wx.showShareMenu({menus:["shareAppMessage"]});
        } else wx.hideShareMenu();
        this.prepareShareImage(report);
      } else {
        this.setData({
          report: null,
          loadError: "暂无报告数据"
        });
      }
    } catch (error) {
      if (generation !== this.reportPreviewGeneration) return;
      this.setData({
        report: null,
        loadError: error.message || "报告加载失败"
      });
      wx.showToast({
        title: getErrorMessage(error, "报告加载失败"),
        icon: "none"
      });
    } finally {
      if (generation === this.reportPreviewGeneration) this.setData({ loading: false });
    }
  },
  /**
   * 准备分享卡片图片。
   *
   * 分享卡需要一个 https 图片地址，而报告里的图片是 cloud:// fileID，
   * 不能直接用于分享卡。所以在加载后把它换成临时链接并缓存下来 ——
   * onShareAppMessage 是同步函数，无法在那里等待网络。
   */
  async prepareShareImage(report) {
    const generation = this.reportPreviewGeneration || 0;
    const reportId = (report && report._id) || this.data.reportId || "";
    const isCurrentReport = () => generation === this.reportPreviewGeneration &&
      (!reportId || !this.data.report || !this.data.report._id || this.data.report._id === reportId);
    const items = (report && report.items) || [];
    const first = items.find((item) => (item.annotatedImages && item.annotatedImages[0]) || (item.images && item.images[0]));
    if (!first) {
      if (isCurrentReport()) this.setData({ shareImageUrl: "" });
      return;
    }

    const fileId = (first.annotatedImages && first.annotatedImages[0]) || (first.images && first.images[0]);
    if (!fileId || !fileId.startsWith("cloud://")) {
      if (isCurrentReport()) this.setData({ shareImageUrl: fileId || "" });
      return;
    }

    try {
      const result = await wx.cloud.getTempFileURL({ fileList: [fileId] });
      if (!isCurrentReport()) return;
      const file = (result.fileList || [])[0] || {};
      this.setData({ shareImageUrl: file.tempFileURL || "" });
    } catch (error) {
      console.warn("[report-detail] 分享图片准备失败，将使用默认卡片", error);
    }
  },

  async manageShare(){
    if(!this.data.isOwner || !this.data.reportId)return;
    const revoked=this.data.report.shareState==="revoked";
    const hasToken=Boolean(this.data.report && this.data.report.shareToken);
    const shareChoices=revoked
      ? [{key:"create",label:"生成新链接",detail:"旧链接已失效；新链接仅可查看这份报告。"}]
      : hasToken
        ? [
          {key:"revoke",label:"撤销当前链接",detail:"停止通过当前链接在线查看这份报告。",danger:true},
          {key:"rotate",label:"重新生成链接",detail:"更换链接并立即让旧链接失效。"}
        ]
        : [{key:"create",label:"生成可转发链接",detail:"为这份报告准备只读链接；不会发送给任何人。"}];
    this.setData({sharePanelOpen:true,sharePanelMode:"actions",shareChoices,shareAction:"",shareActionError:"",shareBusy:false});
  },
  closeSharePanel(){if(this.data.shareBusy)return;this.setData({sharePanelOpen:false,shareAction:"",shareActionError:""});},
  ignoreSharePanelTap(){},
  chooseShareAction(event){
    if(this.data.shareBusy)return;
    const action=event.currentTarget.dataset.action;
    const config={
      create:{title:"生成只读分享链接？",copy:"链接打开后只能查看这份报告，不会获得项目或账号权限。生成链接后仍需你主动点微信转发。",label:"生成链接"},
      rotate:{title:"重新生成分享链接？",copy:"旧链接将立即失效；已经保存到本地的文件、截图或照片无法远程收回。",label:"重新生成"},
      revoke:{title:"撤销在线分享？",copy:"当前链接将立即失效；已经保存到本地的文件、截图或照片无法远程收回。",label:"确认撤销",danger:true}
    }[action];
    if(!config)return;
    this.setData({sharePanelMode:"confirm",shareAction:action,shareConfirmTitle:config.title,shareConfirmCopy:config.copy,shareConfirmLabel:config.label,shareConfirmDanger:!!config.danger,shareActionError:""});
  },
  async confirmShareAction(){
    if(this.data.shareBusy||!this.data.shareAction||!this.data.isOwner)return;
    const action=this.data.shareAction;
    this.setData({shareBusy:true,shareActionError:""});
    try{
      if(action==="revoke")await revokeReportShareToken(this.data.reportId);
      else await createReportShareToken(this.data.reportId,action==="rotate"||this.data.report?.shareState==="revoked");
      this.setData({sharePanelOpen:false,shareBusy:false,shareToken:"",shareAction:"",shareActionError:""});
      await this.loadReport();
      wx.showToast({title:action==="revoke"?"已撤销":"新链接已就绪",icon:"success"});
    }catch(error){
      this.setData({sharePanelMode:"error",shareBusy:false,shareActionError:error.message||"暂时无法完成，请检查网络后重试。"});
    }
  },
  /** 收件人从分享链接进入时的只读视图说明 */
  buildSharePath() {
    const token = (this.data.report && this.data.report.shareToken) || this.data.shareToken || "";
    const base = `/pages/report/detail/index?reportId=${encodeURIComponent(this.data.reportId || "")}`;
    return token ? `${base}&shareToken=${encodeURIComponent(token)}` : base;
  },

  onShareAppMessage() {
    // 微信转发直接进入当前只读在线报告；报告本身就是交付物。
    if (!this.data.reportId || this.data.report?.shareState==="revoked") {
      return {
        title: "巡查报告",
        path: this.buildSharePath()
      };
    }
    return {
      title: `${this.data.report.companyName ? this.data.report.companyName + ' · ' : ''}${this.data.report.projectName || "项目"}巡查报告`,
      path: this.buildSharePath(),
      imageUrl: this.data.shareImageUrl || ""
    };
  },

  onShareTimeline() {
    return {
      title: `${(this.data.report && this.data.report.projectName) || "项目"}巡查报告`,
      query: this.buildSharePath().split("?")[1] || "",
      imageUrl: this.data.shareImageUrl || ""
    };
  }
});
