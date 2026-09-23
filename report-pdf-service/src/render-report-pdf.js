const puppeteer = require("puppeteer");
const { buildReportHtml } = require("./report-template");
const { sanitizeImageUrl } = require("./url-guard");

async function renderReportPdf(reportPayload) {
  const launchOptions = {
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request",request=>sanitizeImageUrl(request.url()) ? request.continue() : request.abort());
    const html = buildReportHtml(reportPayload);
    await page.emulateMediaType("print");
    await page.setContent(html, {
      waitUntil: "networkidle0"
    });
    const broken=await page.evaluate(()=>Array.from(document.images).some(i=>!i.complete||!i.naturalWidth));
    if(broken)throw new Error("报告图片加载失败，请按原报告重试；不会生成缺少现场照片的 PDF");
    await page.evaluate(()=>document.fonts.ready);

    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: '<div style="font-size:9px;color:#706D67;width:100%;padding:0 14mm;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: {
        top: "14mm", right: "14mm", bottom: "18mm", left: "14mm"
      }
    });
  } finally {
    await browser.close();
  }
}

module.exports = {
  renderReportPdf
};
