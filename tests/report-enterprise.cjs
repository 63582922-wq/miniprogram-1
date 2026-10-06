// Enterprise-style report fixture. Offline only: image requests are fulfilled
// from the local design fixture, so this never touches customer data or cloud.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('../report-pdf-service/node_modules/puppeteer');
const { buildReportHtml, groupItemsByImage } = require('../report-pdf-service/src/report-template');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'output/pdf/report-enterprise-20260928.pdf');
const fixtureImage = path.join(root, 'docs/redesign-2026-09-20/site-detail.png');
const fixtureLogo = path.join(root, 'docs/brand/sample-furniture-test-logo.png');
const imageUrl = 'https://offline-fixture.tcb.qcloud.la/enterprise-site.png';
const logoUrl = 'https://offline-fixture.tcb.qcloud.la/enterprise-logo.png';

async function main() {
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const report = {
    title: '现场巡查报告',
    reportNo: 'CB-20260928-SAMPLE',
    projectName: '云栖里 · 木作验收',
    projectAddress: '示例市示例区示例路36号',
    inspectionDateText: '2026-09-28',
    inspectorName: '张工',
    inspectorPhone: '13900000000',
    publisherName: '张工',
    publisherPhone: '13900000000',
    companyName: '示例市示例家具有限公司',
    companyPhone: '13900000000',
    companyAddress: '示例市示例区示例路36号',
    logoUrl,
    testLabel: '隔离测试样本 · 图片为设计演示素材，不是真实客户交付',
    summary: '本次记录覆盖木作收口、窗台细节与现场成品保护。问题已按照片位置分组，并由记录人核对后形成本报告。',
    photos: [
      { id: 'photo-1', imagePath: imageUrl, annotatedImagePath: imageUrl },
      { id: 'photo-2', imagePath: imageUrl },
      { id: 'photo-3', imagePath: imageUrl }
    ],
    items: [
      { sourcePhotoId: 'photo-1', subIssueIndex: 1, description: '窗台收口处存在待处理缝隙，需现场复核后完成收口。', suggestion: '请补充收口材料并在复核后更新现场记录。', severityText: '一般', responsiblePartyText: '木作班组' },
      { sourcePhotoId: 'photo-1', subIssueIndex: 2, description: '同一照片内的第二处细节需要补充处理说明。', suggestion: '处理完成后重新拍照留档。', severityText: '一般', responsiblePartyText: '木作班组' },
      { sourcePhotoId: 'photo-3', subIssueIndex: 1, description: '现场成品保护状态需要在下一次巡查时再次确认。', severityText: '一般', responsiblePartyText: '现场负责人' }
    ]
  };

  const grouped = groupItemsByImage(report.items, report.photos);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].items.length, 2);
  assert.equal(grouped[1].items.length, 0);
  assert.equal(grouped[2].items.length, 1);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 794, height: 1123 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url() === logoUrl) {
        request.respond({
          status: 200,
          contentType: 'image/png',
          body: fs.readFileSync(fixtureLogo)
        });
        return;
      }
      if (request.url() === imageUrl) {
        request.respond({
          status: 200,
          contentType: 'image/png',
          body: fs.readFileSync(fixtureImage)
        });
        return;
      }
      request.abort();
    });
    await page.setContent(buildReportHtml(report), { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');
    assert.match(await page.$eval('.header', node => node.textContent), /示例市示例家具有限公司/);
    assert.match(await page.$eval('.document-meta', node => node.textContent), /CB-20260928-SAMPLE/);
    assert.equal(await page.$$eval('.photo', nodes => nodes.length), 3);
    assert.equal(await page.evaluate(() => Array.from(document.images).filter(image => !image.naturalWidth).length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > 794), false);
    assert.deepEqual(errors, []);

    await page.pdf({
      path: output,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:9px;text-align:right;width:100%;padding:0 14mm;color:#706D67"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '14mm', bottom: '18mm', left: '14mm', right: '14mm' }
    });
    console.log(`Enterprise PDF: ${output}; photos=3; issue groups=2; zero-issue group retained.`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
