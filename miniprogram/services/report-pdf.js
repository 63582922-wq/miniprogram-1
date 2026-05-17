const DEFAULT_PDF_SERVICE_URL = "https://pdf.haolizhiguan.cn";

function decodeArrayBufferToText(buffer) {
  try {
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder("utf-8").decode(buffer);
    }
  } catch (_error) {
  }

  try {
    const bytes = new Uint8Array(buffer);
    let text = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      text += String.fromCharCode.apply(null, chunk);
    }
    return decodeURIComponent(escape(text));
  } catch (_error) {
    return "";
  }
}

function getFileNameFromHeaders(headers = {}) {
  const disposition = headers["Content-Disposition"] || headers["content-disposition"] || "";
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch (_error) {
      return utf8Match[1];
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return (plainMatch && plainMatch[1]) || "";
}

function requestPdfBinary(url, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: "POST",
      data,
      responseType: "arraybuffer",
      header: {
        "content-type": "application/json"
      },
      success: (res) => {
        if (res.statusCode >= 400) {
          const errorText = decodeArrayBufferToText(res.data);
          try {
            const payload = JSON.parse(errorText || "{}");
            reject(new Error(payload.message || "Puppeteer PDF 服务调用失败"));
          } catch (_error) {
            reject(new Error(errorText || "Puppeteer PDF 服务调用失败"));
          }
          return;
        }
        resolve({
          arrayBuffer: res.data,
          fileName: getFileNameFromHeaders(res.header) || `${data.title || "report"}.pdf`
        });
      },
      fail: (error) => {
        reject(new Error(error.errMsg || "Puppeteer PDF 服务调用失败"));
      }
    });
  });
}

function generateReportPdfByService(serviceUrl, payload) {
  void serviceUrl;
  return requestPdfBinary(`${DEFAULT_PDF_SERVICE_URL}/api/report-pdf/generate`, payload);
}

module.exports = {
  generateReportPdfByService
};
