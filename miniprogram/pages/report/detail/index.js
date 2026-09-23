const { getReportDetail, buildReportData, saveReport, createReportPdfTask, getReportPdfTaskStatus } = require("../../../services/report");
const { getSettings } = require("../../../services/settings");
const { mapSeverityText, mapResponsiblePartyText, formatDate, formatDateTime, toChineseSectionNumber, usesEditorialTypeface } = require("../../../utils/format");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");
const { createReportShareToken, revokeReportShareToken } = require("../../../services/report");

const CURRENT_PDF_TEMPLATE_VERSION = "warm-editorial-v3";
const PDF_RUNTIME_VERSION = "pdf-debug-20260407-v5";
const PDF_TASK_POLL_INTERVAL = 3000;
/** 「PDF 生成中」超过这个时长即视为卡死，允许重新发起 */
const STALE_PDF_GENERATING_MS = 3 * 60 * 1000;

/** 严重度：由重到轻，用于摘要卡与分布条的固定顺序 */
const SEVERITY_KEYS = ["critical", "major", "normal"];
const SEVERITY_LABELS = { critical: "严重", major: "较重", normal: "一般" };

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
function buildReportNo(report = {}) {
  const raw = report.publishedAt || report.createdAt || report.generatedAt || report.inspectionDate;
  const date = new Date(Number(raw) || raw);
  const valid = !Number.isNaN(date.getTime());
  const ymd = valid
    ? `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
    : "00000000";
  const tail = `${report._id || ""}`.slice(-4).toUpperCase();
  return `HLZG-${ymd}-${tail || "0000"}`;
}

/**
 * 按照片分组并编号。
 *
 * 新报告按稳定照片 ID 分组，保留「问题 一 / 1. / 2.」。
 * 旧报告无法确定来源关系时保留原来的图片分组与顺序。
 */
function buildIssueGroups(items = [], photos = []) {
  const groups = [];
  const map = new Map();
  photos.forEach((p,i)=>{const g={key:p.id,sourceIndex:p.sourceIndex??i,image:"",originalImage:p.imagePath||"",annotatedImage:p.annotatedImagePath||"",caption:p.caption||"",issues:[]};groups.push(g);map.set(p.id,g);});

  items.forEach((item, index) => {
    const primaryImage = (item.annotatedImages && item.annotatedImages[0])
      || (item.images && item.images[0])
      || "";
    const sourceIndex = Number.isInteger(item.sourceIndex) ? item.sourceIndex : index;
    const key = item.sourcePhotoId || primaryImage || `source-${sourceIndex}`;

    if (!map.has(key)) {
      const group = {
        key,
        sourceIndex,
        image: primaryImage,
        issues: []
      };
      map.set(key, group);
      groups.push(group);
    }

    const group = map.get(key);
    group.issues.push(Object.assign({}, item, {
      // 归一化严重度：模板里要拼 class，未填时会拼出 --undefined
      severity: SEVERITY_KEYS.includes(item.severity) ? item.severity : "normal",
      severityText: SEVERITY_LABELS[item.severity] || "一般",
      responsibleText: mapResponsiblePartyText(item.responsibleParty),
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
    // 有问题的照片保留「问题 一 / 1. / 2.」；纯现场照片不伪装成问题。
    // 两者沿用同一照片顺序，在线报告与 PDF 必须一致。
    group.groupTitle = `${group.issues.length ? "问题" : "现场照片"} ${toChineseSectionNumber(groupIndex + 1)}`;

    group.issues.forEach((issue, issueIndex) => {
      issue.displayNo = `${issue.subIssueIndex || issueIndex + 1}.`;
    });
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

function isCloudFileId(value = "") {
  return typeof value === "string" && value.startsWith("cloud://");
}

async function resolvePublicFileUrl(filePath = "") {
  if (!filePath) {
    return "";
  }
  if (typeof filePath === "string" && filePath.startsWith("wxfile://")) {
    return "";
  }
  if (!isCloudFileId(filePath)) {
    return filePath;
  }
  const result = await wx.cloud.getTempFileURL({
    fileList: [filePath]
  });
  const first = result.fileList && result.fileList[0];
  if (first && first.status && first.status !== 0) {
    throw new Error(first.errMsg || "云文件临时链接获取失败");
  }
  return (first && first.tempFileURL) || "";
}

// Keep other downloaded reports. Storage pressure must never silently delete them.
function persistDownloadedPdfFile(tempFilePath, fileName = "report.pdf") {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    const safeName = fileName.replace(/[\\\\/:*?"<>|]/g, "-");
    const targetFilePath = `${wx.env.USER_DATA_PATH}/${safeName}`;
    if (tempFilePath === targetFilePath) { resolve(targetFilePath); return; }
    fs.copyFile({srcPath:tempFilePath,destPath:targetFilePath,
      success:()=>resolve(targetFilePath),fail:reject});
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatPdfDate(value) {
  if (!value) {
    return "";
  }
  const text = `${value}`;
  if (/^\d{8}$/.test(text)) {
    return text;
  }
  return text.replace(/\D/g, "").slice(0, 8);
}

function buildPdfFileName(report = {}) {
  const projectName = `${report.projectName || report.title || "report"}`.trim();
  const datePart = formatPdfDate(report.inspectionDate);
  return `${projectName}${datePart || ""}-${buildReportNo(report)}.pdf`;
}

function isPersistentLocalPath(filePath = "") {
  return typeof filePath === "string" && filePath.indexOf(wx.env.USER_DATA_PATH) === 0;
}

function buildReportDisplayState(report = {}) {
  const hasGeneratedPdf = Boolean(report.pdfFileId);
  const isPdfOutdated = Boolean(hasGeneratedPdf && report.pdfTemplateVersion !== CURRENT_PDF_TEMPLATE_VERSION);

  // 判定「生成中」是否已经卡死。
  //
  // 服务端挂了、被重启、或网络半途断掉时，reports.status 会永远停在
  // pdf_generating。而界面上「生成中」既不给重试入口、顶部守卫也会挡住
  // 重新发起 —— 用户就彻底出不来了（实测踩到过）。
  // 超过阈值即视为失败，允许重新发起。
  const generatingSince = Number(report.updatedAt || report.createdAt || 0);
  const generatingStale = !report.snapshotVersion && report.status === "pdf_generating"
    && generatingSince > 0
    && (Date.now() - generatingSince) > STALE_PDF_GENERATING_MS;

  const isPdfGenerating = report.status === "pdf_generating" && !generatingStale;
  const isPdfFailed = report.status === "pdf_failed" || generatingStale;

  let statusText = "待生成 PDF";
  if (isPdfGenerating) {
    statusText = "PDF 生成中";
  } else if (isPdfFailed) {
    statusText = report.pdfErrorMessage ? `PDF 生成失败：${report.pdfErrorMessage}` : "PDF 生成超时，可重试";
  } else if (isPdfOutdated) {
    statusText = "PDF 模板已更新，需重新生成";
  } else if (hasGeneratedPdf) {
    statusText = "已生成 PDF";
  }
  return {
    ...report,
    inspectionDateDisplay: report.inspectionDateText || report.inspectionDate,
    generatedAtDisplay: formatDateTime(report.publishedAt || report.createdAt || report.generatedAt) || "",
    // 首屏需要的摘要信息：读者先看到「几个问题、几个严重」再决定要不要往下看
    reportNo: buildReportNo(report),
    severityStats: buildSeverityStats(report.items || []),
    conclusion: buildConclusion(buildSeverityStats(report.items || [])),
    issueGroups: buildIssueGroups(report.items || [], report.photos || []),
    statusText,
    // 转发只要求报告存在 —— 报告页本身就是交付物，
    // 不该等到生成 PDF 才能发给业主和施工方
    canShare: Boolean(report._id),
    isPdfOutdated,
    isPdfGenerating,
    isPdfFailed
  };
}

Page({
  data: {
    reportId: "",
    inspectionId: "",
    /** 收件人从分享链接带过来的只读凭据 */
    shareToken: "",
    /** 报告是否由当前用户拥有；非拥有者只看只读视图 */
    isOwner: true,
    /** 分享卡片用的 https 图片地址（cloud:// 不能直接用于分享卡） */
    shareImageUrl: "",
    returnContext: null,
    report: null,
    pdfFilePath: "",
    pdfStatusError: "",
    pdfSubmitting: false,
    loading: true,
    loadError: "",
    reportTitleClass: "report-cover__title--ui"
  },
  async onLoad(query) {
    this.setData({
      reportId: query.reportId || "",
      inspectionId: query.inspectionId || "",
      shareToken: query.shareToken || "",
      returnContext: decodeReturnContext(query.returnContext) || null
    });
    wx.hideShareMenu();
  },
  async onShow() {
    this.pdfPageHidden = false;
    this.pdfPollFailures = 0;
    this.setData({pdfStatusError:""});
    await this.loadReport();
    this.resumePdfTaskPolling();
  },
  onHide(){this.pdfPageHidden=true;this.clearPdfTaskPolling();},
  onUnload() {
    this.pdfPageHidden = true;
    this.clearPdfTaskPolling();
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
  /** 点图片放大看细节 —— 报告的使命就是让人看清问题 */
  handlePreviewImage(event) {
    const src = event.currentTarget.dataset.src;
    if (!src) {
      return;
    }

    const urls = [];
    (this.data.report && this.data.report.issueGroups || []).forEach((group) => {
      if (group.image) {
        urls.push(group.image);
      }
    });

    wx.previewImage({
      current: src,
      urls: urls.length ? urls : [src]
    });
  },
  async loadReport() {
    this.setData({
      loading: true,
      loadError: ""
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

      if (report) {
        if (report.pdfFileId) {
          markGuideStep("reportGenerated", true);
        }
        const displayTitle = report.projectName || report.title || "";
        this.setData({
          report: buildReportDisplayState(report),
          isOwner: report.accessMode !== "shared",
          reportTitleClass: usesEditorialTypeface(displayTitle) ? "" : "report-cover__title--ui"
        });
        if (report._id) {
          this.setData({
            reportId: report._id
          });
        }
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
      this.setData({
        report: null,
        loadError: error.message || "报告加载失败"
      });
      wx.showToast({
        title: getErrorMessage(error, "报告加载失败"),
        icon: "none"
      });
    } finally {
      this.setData({
        loading: false
      });
    }
  },
  async buildPuppeteerPayload(logoFileId) {
    const logoUrl = await resolvePublicFileUrl(logoFileId);
    const items = await Promise.all((this.data.report.items || []).map(async (item, index) => {
      const primaryAnnotatedImage = item.annotatedImages && item.annotatedImages[0]
        ? await resolvePublicFileUrl(item.annotatedImages[0])
        : "";
      const primaryImage = item.images && item.images[0]
        ? await resolvePublicFileUrl(item.images[0])
        : "";
      return {
        order: index + 1,
        category: item.category || "",
        area: item.area || "",
        location: item.location || "",
        description: item.description || "",
        suggestion: item.suggestion || "",
        severityText: mapSeverityText(item.severity),
        responsiblePartyText: mapResponsiblePartyText(item.responsibleParty),
        annotatedImages: primaryAnnotatedImage ? [primaryAnnotatedImage] : [],
        images: primaryImage ? [primaryImage] : []
      };
    }));

    return {
      title: this.data.report.title,
      projectName: this.data.report.projectName,
      inspectionDate: formatDate(this.data.report.inspectionDate),
      inspectorName: this.data.report.inspectorName,
      inspectorPhone: this.data.report.inspectorPhone,
      summary: this.data.report.summary,
      contextNote: this.data.report.contextNote,
      companyName: this.data.report.companyName || "",
      companyPhone: this.data.report.companyPhone || "",
      publisherName: this.data.report.publisherName || "",
      publisherPhone: this.data.report.publisherPhone || "",
      companyAddress: this.data.report.companyAddress || "",
      logoUrl,
      logoFileId,
      items
    };
  },
  async ensureReportForPdf(logoFileId) {
    if(this.data.report.snapshotVersion)return this.data.report;
    const saved = await saveReport({
      reportId: this.data.reportId,
      inspectionId: this.data.report.inspectionId,
      projectId: this.data.report.projectId,
      title: this.data.report.title,
      summary: this.data.report.summary,
      contextNote: this.data.report.contextNote,
      companyName: this.data.report.companyName,
      companyPhone: this.data.report.companyPhone,
      companyAddress: this.data.report.companyAddress,
      logoFileId,
      reportTemplate: this.data.report.reportTemplate,
      status: "pdf_generating",
      pdfFileId: "",
      pdfTemplateVersion: "",
      pdfTaskId: "",
      pdfTaskStatus: "queued",
      pdfErrorMessage: ""
    });
    const report = buildReportDisplayState({
      ...this.data.report,
      ...saved,
      logoFileId
    });
    this.setData({
      reportId: saved._id || this.data.reportId,
      report
    });
    return report;
  },
  clearPdfTaskPolling() {
    if (this.pdfTaskPollTimer) {
      clearTimeout(this.pdfTaskPollTimer);
      this.pdfTaskPollTimer = null;
    }
  },
  schedulePdfTaskPolling(autoOpen = false) {
    this.clearPdfTaskPolling();
    if (this.pdfPageHidden) return;
    this.pdfTaskAutoOpen = Boolean(autoOpen || this.pdfTaskAutoOpen);
    this.pdfTaskPollTimer = setTimeout(() => {
      this.pollPdfTaskStatus().catch((error) => {
        if (this.pdfPageHidden) return;
        this.pdfPollFailures = (this.pdfPollFailures || 0) + 1;
        if (this.pdfPollFailures < 3) { this.schedulePdfTaskPolling(false); return; }
        this.pdfTaskAutoOpen = false;
        this.setData({pdfStatusError:"暂时无法查询 PDF 状态。报告内容不受影响，恢复网络后可继续查询。"});
      });
    }, PDF_TASK_POLL_INTERVAL);
  },
  async retryPdfStatus() {
    this.pdfPollFailures = 0;
    this.setData({pdfStatusError:""});
    await this.loadReport();
    if (!this.data.loadError) this.resumePdfTaskPolling();
  },
  resumePdfTaskPolling() {
    if (this.data.report && this.data.report.pdfTaskId && this.data.report.status === "pdf_generating") {
      this.schedulePdfTaskPolling(false);
    }
  },
  async openPdfFileById(pdfFileId) {
    const result = await wx.cloud.downloadFile({
      fileID: pdfFileId
    });
    const tempFilePath = result.tempFilePath || "";
    if (!tempFilePath) {
      throw new Error("云存储 PDF 下载失败");
    }
    this.setData({
      pdfFilePath: tempFilePath
    });
    await this.openDocumentSafely(tempFilePath);
  },
  async pollPdfTaskStatus() {
    if (!this.data.report || !this.data.report.pdfTaskId) {
      this.clearPdfTaskPolling();
      return;
    }
    const response = await getReportPdfTaskStatus({
      reportId: this.data.reportId,
      taskId: this.data.report.pdfTaskId,
      pdfTemplateVersion: CURRENT_PDF_TEMPLATE_VERSION
    });
    if (this.pdfPageHidden) return;
    this.pdfPollFailures = 0;
    this.setData({pdfStatusError:""});
    const nextReport = buildReportDisplayState({
      ...this.data.report,
      ...(response.report || {})
    });
    this.setData({
      report: nextReport,
      reportId: nextReport._id || this.data.reportId
    });
    if (response.taskStatus === "success" && nextReport.pdfFileId) {
      markGuideStep("reportGenerated", true);
      this.clearPdfTaskPolling();
      if (this.pdfTaskAutoOpen) {
        this.pdfTaskAutoOpen = false;
        wx.showLoading({
          title: "打开中"
        });
        try {
          await this.openPdfFileById(nextReport.pdfFileId);
        } catch (error) {
          wx.showToast({
            title: getErrorMessage(error, "打开失败"),
            icon: "none"
          });
        } finally {
          wx.hideLoading();
        }
      }
      return;
    }
    if (response.taskStatus === "failed") {
      this.clearPdfTaskPolling();
      this.pdfTaskAutoOpen = false;
      wx.showModal({
        title: "PDF 生成失败",
        content: response.errorMessage || nextReport.pdfErrorMessage || "PDF 生成失败",
        showCancel: false,
        confirmText: "知道了"
      });
      return;
    }
    this.schedulePdfTaskPolling(false);
  },
  async openDocumentSafely(filePath) {
    wx.hideLoading();
    await wait(80);
    return wx.openDocument({
      filePath,
      showMenu: true
    });
  },
  async generatePdf() {
    if (!this.data.report || this.data.pdfSubmitting) {
      return;
    }
    if (this.data.report.isPdfGenerating) {
      wx.showToast({
        title: "PDF 正在生成中",
        icon: "none"
      });
      return;
    }

    this.setData({pdfSubmitting:true,pdfStatusError:""});
    this.pdfPollFailures = 0;
    let currentStage = "准备生成 PDF";
    wx.showLoading({
      title: "提交中"
    });

    try {
      currentStage = "读取 PDF 配置";
      const settings = this.data.report.snapshotVersion ? {} : await getSettings();
      const logoFileId = this.data.report.logoFileId || (settings && settings.logoFileId ? settings.logoFileId : "");
      currentStage = "保存报告";
      await this.ensureReportForPdf(logoFileId);
      currentStage = "提交 PDF 任务";
      const response = await createReportPdfTask({
        reportId: this.data.reportId,
        // The server resolves the frozen publication; client data is not authoritative.
      });
      const nextReport = buildReportDisplayState({
        ...this.data.report,
        ...(response.report || {})
      });
      this.setData({
        report: nextReport,
        reportId: nextReport._id || this.data.reportId
      });
      this.pdfTaskAutoOpen = true;
      this.schedulePdfTaskPolling(true);
      wx.showToast({
        title: "已提交生成任务",
        icon: "success"
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error, "生成失败");
      console.error("[report-detail] generatePdf failed", {
        runtimeVersion: PDF_RUNTIME_VERSION,
        stage: currentStage,
        error
      });

      // 失败必须把状态改回来。
      // ensureReportForPdf 已经把 status 置成 pdf_generating，不回退的话
      // 报告会永远停在「PDF 生成中」，而且不能再发起 —— 用户彻底出不来。
      let failedReport = buildReportDisplayState({
        ...this.data.report,
        status: "pdf_failed",
        pdfErrorMessage: `${currentStage}：${errorMessage}`.slice(0, 200)
      });

      if (this.data.reportId && !this.data.report.snapshotVersion) {
        try {
          const saved = await saveReport({
            reportId: this.data.reportId,
            status: "pdf_failed",
            pdfErrorMessage: `${currentStage}：${errorMessage}`.slice(0, 200)
          });
          failedReport = buildReportDisplayState({
            ...this.data.report,
            ...(saved || {}),
            status: "pdf_failed"
          });
        } catch (saveError) {
          console.error("[report-detail] 回写失败状态未成功，仅本地生效", saveError);
        }
      }

      this.setData(this.data.report?.snapshotVersion
        ? {pdfStatusError:"PDF 提交结果未确认。请恢复网络后查询原任务，不会重复创建报告。"}
        : {report:failedReport});

      wx.showModal({
        title: "PDF 生成失败",
        content: `${currentStage}：${errorMessage}\n\n报告内容不受影响，可以直接转发阅读；PDF 稍后可重试。`,
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
      this.setData({pdfSubmitting:false});
      wx.hideLoading();
    }
  },
  async openPdf() {
    if (!this.data.report || !this.data.report.pdfFileId) {
      if (this.data.report && this.data.report.isPdfGenerating) {
        wx.showToast({
          title: "PDF 仍在生成中",
          icon: "none"
        });
        return;
      }
      wx.showToast({
        title: "还没有生成 PDF",
        icon: "none"
      });
      return;
    }
    if (this.data.report.isPdfOutdated) {
      wx.showToast({
        title: "当前是旧版 PDF，请先重新生成",
        icon: "none"
      });
      return;
    }

    wx.showLoading({
      title: "打开中"
    });

    try {
      await this.openPdfFileById(this.data.report.pdfFileId);
    } catch (error) {
      wx.showToast({
        title: getErrorMessage(error, "打开失败"),
        icon: "none"
      });
    } finally {
      wx.hideLoading();
    }
  },
  async savePdfToLocal() {
    if (!this.data.report || !this.data.report.pdfFileId) {
      wx.showToast({
        title: "还没有生成 PDF",
        icon: "none"
      });
      return;
    }
    if (this.data.report.isPdfOutdated) {
      wx.showToast({
        title: "当前是旧版 PDF，请先重新生成",
        icon: "none"
      });
      return;
    }

    wx.showLoading({
      title: "保存中"
    });

    try {
      let filePath = this.data.pdfFilePath || "";
      if (!filePath) {
        const result = await wx.cloud.downloadFile({
          fileID: this.data.report.pdfFileId
        });
        filePath = result.tempFilePath || "";
      }

      if (!filePath) {
        throw new Error("PDF 文件不存在");
      }

      if (!isPersistentLocalPath(filePath)) {
        try {
          filePath = await persistDownloadedPdfFile(filePath, buildPdfFileName(this.data.report));
        } catch (error) {
          throw new Error("PDF 未能保存到本地，请检查存储空间后重试。已有文件不会被自动删除。");
        }
      }

      this.setData({
        pdfFilePath: filePath
      });
      await this.openDocumentSafely(filePath);
    } catch (error) {
      wx.showToast({
        title: getErrorMessage(error, "保存失败"),
        icon: "none"
      });
    } finally {
      wx.hideLoading();
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
    const items = (report && report.items) || [];
    const first = items.find((item) => (item.annotatedImages && item.annotatedImages[0]) || (item.images && item.images[0]));
    if (!first) {
      return;
    }

    const fileId = (first.annotatedImages && first.annotatedImages[0]) || (first.images && first.images[0]);
    if (!fileId || !fileId.startsWith("cloud://")) {
      this.setData({ shareImageUrl: fileId || "" });
      return;
    }

    try {
      const result = await wx.cloud.getTempFileURL({ fileList: [fileId] });
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
    const choice=await new Promise(resolve=>wx.showActionSheet({itemList:revoked?["生成新分享链接"]:(hasToken?["撤销当前链接","重新生成链接"]:["生成可转发链接"]),success:resolve,fail:()=>resolve(null)}));
    if(!choice)return;
    const revoke=!revoked&&hasToken&&choice.tapIndex===0;
    const confirmed=await new Promise(resolve=>wx.showModal({title:revoke?"撤销在线分享？":(hasToken||revoked?"生成新链接？":"生成可转发链接？"),content:revoke||hasToken||revoked?"旧链接将失效。已下载的 PDF、截图或照片无法远程收回。":"将只为当前这份报告生成只读链接。",success:resolve}));
    if(!confirmed.confirm)return;
    try{
      if(revoke)await revokeReportShareToken(this.data.reportId);
      else await createReportShareToken(this.data.reportId,hasToken || revoked);
      this.setData({shareToken:""});await this.loadReport();
      wx.showToast({title:revoke?"已撤销":"新链接已就绪",icon:"success"});
    }catch(e){wx.showModal({title:"分享设置未完成",content:e.message||"请重试",showCancel:false});}
  },
  /** 收件人从分享链接进入时的只读视图说明 */
  buildSharePath() {
    const token = (this.data.report && this.data.report.shareToken) || this.data.shareToken || "";
    const base = `/pages/report/detail/index?reportId=${encodeURIComponent(this.data.reportId || "")}`;
    return token ? `${base}&shareToken=${encodeURIComponent(token)}` : base;
  },

  onShareAppMessage() {
    // 分享的是只读报告页，不需要先生成 PDF。
    // 原实现要求 canShare（依赖 pdfFileId），等于「没出 PDF 就不能转发」；
    // 而报告页本身就是交付物，线上阅读才是主要形态。
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
