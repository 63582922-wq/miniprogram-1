const { getReportDetail, buildReportData, saveReport, createReportPdfTask, getReportPdfTaskStatus } = require("../../../services/report");
const { getSettings } = require("../../../services/settings");
const { mapSeverityText, mapResponsiblePartyText, formatDate, formatDateTime, toChineseSectionNumber } = require("../../../utils/format");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");

const CURRENT_PDF_TEMPLATE_VERSION = "puppeteer-doc-v19";
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
    return "本次巡查未发现问题。";
  }
  const parts = [`本次共发现问题 ${stats.total} 项`];
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
  const raw = report.generatedAt || report.createdAt || report.inspectionDate;
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
 * 同一张照片的多个问题只出现一次照片，编号 1-A / 1-B；
 * 这样现场说「问题 1-A」所有人都知道指哪一条。
 */
function buildIssueGroups(items = []) {
  const groups = [];
  const map = new Map();

  items.forEach((item, index) => {
    const primaryImage = (item.annotatedImages && item.annotatedImages[0])
      || (item.images && item.images[0])
      || "";
    const sourceIndex = Number.isInteger(item.sourceIndex) ? item.sourceIndex : index;
    const key = primaryImage || `source-${sourceIndex}`;

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

  groups.sort((a, b) => a.sourceIndex - b.sourceIndex);

  groups.forEach((group, groupIndex) => {
    // 与巡查结果确认页、PDF 模板保持同一套编号：
    // 分组用中文数字「问题 一」，组内子条目用 1. 2.
    // 此前这里用了「问题 1」+「1-A」，导致同一份巡查出现两套编号。
    group.groupTitle = `问题 ${toChineseSectionNumber(groupIndex + 1)}`;
    group.issues.sort((a, b) => (a.subIssueIndex || 1) - (b.subIssueIndex || 1));
    group.issues.forEach((issue, issueIndex) => {
      issue.displayNo = `${issueIndex + 1}.`;
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

function cleanupLocalReportPdfFiles() {
  return new Promise((resolve) => {
    const fs = wx.getFileSystemManager();
    fs.readdir({
      dirPath: wx.env.USER_DATA_PATH,
      success: (result) => {
        const fileList = (result.files || []).filter((name) => /\.pdf$/i.test(name));
        if (!fileList.length) {
          resolve();
          return;
        }
        let pending = fileList.length;
        const done = () => {
          pending -= 1;
          if (pending <= 0) {
            resolve();
          }
        };
        fileList.forEach((name) => {
          fs.unlink({
            filePath: `${wx.env.USER_DATA_PATH}/${name}`,
            success: done,
            fail: done
          });
        });
      },
      fail: () => resolve()
    });
  });
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

function writePdfBufferToFile(arrayBuffer, fileName = "report.pdf") {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    const normalizedFileName = /\.pdf$/i.test(`${fileName || ""}`) ? `${fileName}` : `${fileName || "report"}.pdf`;
    const safeName = `${normalizedFileName}`.replace(/[\\/:*?"<>|]/g, "-");
    const filePath = `${wx.env.USER_DATA_PATH}/${safeName}`;
    cleanupLocalReportPdfFiles()
      .then(() => {
        fs.writeFile({
          filePath,
          data: arrayBuffer,
          success: () => resolve(filePath),
          fail: reject
        });
      })
      .catch(() => {
        fs.writeFile({
          filePath,
          data: arrayBuffer,
          success: () => resolve(filePath),
          fail: reject
        });
      });
  });
}

function persistDownloadedPdfFile(tempFilePath, fileName = "report.pdf") {
  return new Promise((resolve, reject) => {
    const fs = wx.getFileSystemManager();
    const normalizedFileName = /\.pdf$/i.test(`${fileName || ""}`) ? `${fileName}` : `${fileName || "report"}.pdf`;
    const safeName = `${normalizedFileName}`.replace(/[\\/:*?"<>|]/g, "-");
    const targetFilePath = `${wx.env.USER_DATA_PATH}/${safeName}`;
    cleanupLocalReportPdfFiles()
      .then(() => {
        fs.copyFile({
          srcPath: tempFilePath,
          destPath: targetFilePath,
          success: () => resolve(targetFilePath),
          fail: reject
        });
      })
      .catch(() => {
        fs.copyFile({
          srcPath: tempFilePath,
          destPath: targetFilePath,
          success: () => resolve(targetFilePath),
          fail: reject
        });
      });
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
  return `${projectName}${datePart || ""}.pdf`;
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
  const generatingStale = report.status === "pdf_generating"
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
    generatedAtDisplay: formatDateTime(report.generatedAt || report.createdAt) || "",
    // 首屏需要的摘要信息：读者先看到「几个问题、几个严重」再决定要不要往下看
    reportNo: buildReportNo(report),
    severityStats: buildSeverityStats(report.items || []),
    conclusion: buildConclusion(buildSeverityStats(report.items || [])),
    issueGroups: buildIssueGroups(report.items || []),
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
    loading: true,
    loadError: ""
  },
  async onLoad(query) {
    this.setData({
      reportId: query.reportId || "",
      inspectionId: query.inspectionId || "",
      shareToken: query.shareToken || "",
      returnContext: decodeReturnContext(query.returnContext) || null
    });
    wx.showShareMenu({
      withShareTicket: true,
      menus: ["shareAppMessage", "shareTimeline"]
    });
  },
  async onShow() {
    await this.loadReport();
    this.resumePdfTaskPolling();
  },
  onUnload() {
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
        this.setData({
          report: buildReportDisplayState(report),
          isOwner: report.accessMode !== "shared"
        });
        if (report._id) {
          this.setData({
            reportId: report._id
          });
        }
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
      companyPhone: "",
      companyAddress: this.data.report.companyAddress || "",
      logoUrl,
      logoFileId,
      items
    };
  },
  async ensureReportForPdf(logoFileId) {
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
    this.pdfTaskAutoOpen = Boolean(autoOpen || this.pdfTaskAutoOpen);
    this.pdfTaskPollTimer = setTimeout(() => {
      this.pollPdfTaskStatus().catch((error) => {
        console.error("[report-detail] pollPdfTaskStatus failed", error);
      });
    }, PDF_TASK_POLL_INTERVAL);
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
    if (!this.data.report) {
      return;
    }
    if (this.data.report.isPdfGenerating) {
      wx.showToast({
        title: "PDF 正在生成中",
        icon: "none"
      });
      return;
    }

    let currentStage = "准备生成 PDF";
    wx.showLoading({
      title: "提交中"
    });

    try {
      currentStage = "读取 PDF 配置";
      const settings = await getSettings();
      const logoFileId = this.data.report.logoFileId || (settings && settings.logoFileId ? settings.logoFileId : "");
      currentStage = "保存报告";
      await this.ensureReportForPdf(logoFileId);
      currentStage = "提交 PDF 任务";
      const payload = await this.buildPuppeteerPayload(logoFileId);
      const response = await createReportPdfTask({
        reportId: this.data.reportId,
        reportPayload: payload
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

      if (this.data.reportId) {
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

      this.setData({ report: failedReport });

      wx.showModal({
        title: "PDF 生成失败",
        content: `${currentStage}：${errorMessage}\n\n报告内容不受影响，可以直接转发阅读；PDF 稍后可重试。`,
        showCancel: false,
        confirmText: "知道了"
      });
    } finally {
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
          const message = getErrorMessage(error, "");
          if (message && message.includes("storage limit is exceeded")) {
            try {
              await cleanupLocalReportPdfFiles();
            } catch (_cleanupError) {}
            filePath = await persistDownloadedPdfFile(filePath, buildPdfFileName(this.data.report));
          } else {
            throw error;
          }
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

  /** 收件人从分享链接进入时的只读视图说明 */
  buildSharePath() {
    const token = (this.data.report && this.data.report.shareToken) || this.data.shareToken || "";
    const base = `/pages/report/detail/index?reportId=${this.data.reportId}`;
    return token ? `${base}&shareToken=${token}` : base;
  },

  onShareAppMessage() {
    // 分享的是只读报告页，不需要先生成 PDF。
    // 原实现要求 canShare（依赖 pdfFileId），等于「没出 PDF 就不能转发」；
    // 而报告页本身就是交付物，线上阅读才是主要形态。
    if (!this.data.reportId) {
      return {
        title: "巡查报告",
        path: "/pages/report/list/index"
      };
    }
    return {
      title: `${(this.data.report && this.data.report.projectName) || "项目"}巡查报告`,
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
