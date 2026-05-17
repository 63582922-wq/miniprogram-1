const { getReportDetail, buildReportData, saveReport, createReportPdfTask, getReportPdfTaskStatus } = require("../../../services/report");
const { getSettings } = require("../../../services/settings");
const { mapSeverityText, mapResponsiblePartyText, formatDate, formatDateTime } = require("../../../utils/format");
const { decodeReturnContext, returnToContext } = require("../../../utils/router");
const { markGuideStep } = require("../../../utils/guide");
const { isCoachStep, stopCoach, moveCoach, getNextCoachStep, getPrevCoachStep, buildCoachTip } = require("../../../utils/coach");

const CURRENT_PDF_TEMPLATE_VERSION = "puppeteer-doc-v19";
const PDF_RUNTIME_VERSION = "pdf-debug-20260407-v5";
const PDF_TASK_POLL_INTERVAL = 3000;

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
  let statusText = "待生成 PDF";
  if (report.status === "pdf_generating") {
    statusText = "PDF 生成中";
  } else if (report.status === "pdf_failed") {
    statusText = report.pdfErrorMessage ? `PDF 生成失败：${report.pdfErrorMessage}` : "PDF 生成失败";
  } else if (isPdfOutdated) {
    statusText = "PDF 模板已更新，需重新生成";
  } else if (hasGeneratedPdf) {
    statusText = "已生成 PDF";
  }
  return {
    ...report,
    inspectionDateDisplay: report.inspectionDateText || report.inspectionDate,
    generatedAtDisplay: formatDateTime(report.generatedAt || report.createdAt) || "",
    statusText,
    canShare: Boolean(report._id && hasGeneratedPdf && !isPdfOutdated && report.status !== "pdf_generating"),
    isPdfOutdated,
    isPdfGenerating: report.status === "pdf_generating",
    isPdfFailed: report.status === "pdf_failed"
  };
}

Page({
  data: {
    reportId: "",
    inspectionId: "",
    returnContext: null,
    report: null,
    pdfFilePath: "",
    loading: true,
    loadError: "",
    coachTipVisible: false,
    coachTipTitle: "",
    coachTipArrow: "",
    coachTipDesc: "",
    coachHighlightGenerate: false
  },
  syncCoachTip(report = this.data.report) {
    const active = isCoachStep("reportGenerate") && !(report && report.pdfFileId);
    const tip = buildCoachTip("reportGenerate");
    this.setData({
      coachTipVisible: active,
      coachTipTitle: tip.title,
      coachTipArrow: tip.arrow,
      coachTipDesc: tip.desc,
      coachHighlightGenerate: active
    });
  },
  handleCoachSkip() {
    stopCoach();
    this.syncCoachTip();
  },
  handleCoachPrev() {
    const prev = getPrevCoachStep("reportGenerate");
    if (!prev) {
      return;
    }
    moveCoach(prev);
    wx.navigateBack({
      delta: 1
    });
  },
  handleCoachNext() {
    const next = getNextCoachStep("reportGenerate");
    if (next) {
      moveCoach(next);
    }
    this.generatePdf();
  },
  async onLoad(query) {
    this.setData({
      reportId: query.reportId || "",
      inspectionId: query.inspectionId || "",
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
  async loadReport() {
    this.setData({
      loading: true,
      loadError: ""
    });

    let report;
    try {
      if (this.data.reportId) {
        report = await getReportDetail(this.data.reportId);
      } else if (this.data.inspectionId) {
        report = await buildReportData({
          inspectionId: this.data.inspectionId
        });
      }

      if (report) {
        if (report.pdfFileId) {
          markGuideStep("reportGenerated", true);
          if (isCoachStep("reportGenerate")) {
            stopCoach();
          }
        }
        this.setData({
          report: buildReportDisplayState(report),
          coachTipVisible: isCoachStep("reportGenerate") && !report.pdfFileId
        });
        this.syncCoachTip(report);
        if (report._id) {
          this.setData({
            reportId: report._id
          });
        }
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
      this.syncCoachTip(null);
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
      if (isCoachStep("reportGenerate")) {
        stopCoach();
      }
      this.setData({
        coachTipVisible: false
      });
      this.syncCoachTip(nextReport);
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
      wx.showModal({
        title: "PDF 生成失败",
        content: `${currentStage}：${errorMessage}`,
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
  onShareAppMessage() {
    if (!this.data.report || !this.data.report.canShare || !this.data.reportId) {
      return {
        title: "巡查报告",
        path: "/pages/report/list/index"
      };
    }
    return {
      title: this.data.report ? `${this.data.report.projectName || "项目"}巡查报告` : "巡查报告",
      path: `/pages/report/detail/index?reportId=${this.data.reportId}`,
      imageUrl: this.data.report && this.data.report.items && this.data.report.items[0]
        ? ((this.data.report.items[0].annotatedImages && this.data.report.items[0].annotatedImages[0])
          || (this.data.report.items[0].images && this.data.report.items[0].images[0])
          || "")
        : ""
    };
  },
  onShareTimeline() {
    if (!this.data.report || !this.data.report.canShare || !this.data.reportId) {
      return {
        title: "巡查报告",
        query: ""
      };
    }
    return {
      title: this.data.report ? `${this.data.report.projectName || "项目"}巡查报告` : "巡查报告",
      query: `reportId=${this.data.reportId}`,
      imageUrl: this.data.report && this.data.report.items && this.data.report.items[0]
        ? ((this.data.report.items[0].annotatedImages && this.data.report.items[0].annotatedImages[0])
          || (this.data.report.items[0].images && this.data.report.items[0].images[0])
          || "")
        : ""
    };
  }
});
