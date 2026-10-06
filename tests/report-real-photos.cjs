// Legacy PDF compatibility check only. This uses the JPEGs supplied in
// Downloads rather than the design fixture. Its issue rows intentionally have
// no annotationId, markerNumber, point geometry, or annotated image, so this
// script cannot prove that online report markers 1/2/3 appear. It also does not
// replace a real iOS/Android picker + upload test.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const puppeteer = require('../report-pdf-service/node_modules/puppeteer');
const { buildReportHtml, groupItemsByImage } = require('../report-pdf-service/src/report-template');

const root = path.resolve(__dirname, '..');
const photoRoot = '/Users/cft/Downloads/毫厘智管测试测试图';
const photoFiles = [
  '0a96236feb4b32cecff83d346eead830.jpeg',
  '4f577062fcf4a9621bfa7a3d1d256469.jpeg',
  'abc961ab7a90e4b74a33c12b610adc71.jpeg',
  'fPtsF97l7.jpeg'
].map(name => path.join(photoRoot, name));
const logoFile = path.join(root, 'docs/brand/sample-furniture-test-logo.png');
const output = path.join(root, 'output/pdf/report-real-photos-20260928.pdf');
const photoUrls = photoFiles.map((_, index) => `https://real-photo-${index}.tcb.qcloud.la/inspection-${index}.jpeg`);
const logoUrl = 'https://real-photo-assets.tcb.qcloud.la/sample-furniture-test-logo.png';

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

async function main() {
  photoFiles.forEach(file => assert.equal(fs.existsSync(file), true, `real photo missing: ${file}`));
  assert.equal(fs.existsSync(logoFile), true, `test company logo missing: ${logoFile}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const report = {
    title: '现场巡查报告',
    reportNo: 'CB-20260928-REAL',
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
    testLabel: '真实照片验收样本 · 来源：Downloads/毫厘智管测试测试图',
    summary: '本次样本使用现场提供的四张真实照片，验证照片顺序、同图多问题、零问题照片和大尺寸竖图在报告中的呈现。',
    photos: photoUrls.map((imagePath, index) => ({
      id: `real-photo-${index + 1}`,
      imagePath,
      caption: index === 0 ? '真实照片样本，未使用设计演示图片。' : ''
    })),
    items: [
      { sourcePhotoId: 'real-photo-1', subIssueIndex: 1, description: '照片中的现场细节需要补充收口处理，位置以照片为准。', suggestion: '完成处理后重新拍照核对。', severityText: '一般', responsiblePartyText: '木作班组' },
      { sourcePhotoId: 'real-photo-1', subIssueIndex: 2, description: '同一张照片内的第二处问题，验证问题编号不会串到其他照片。', suggestion: '复核完成后保留原问题编号。', severityText: '一般', responsiblePartyText: '木作班组' },
      { sourcePhotoId: 'real-photo-3', subIssueIndex: 1, description: '另一张真实现场照片的问题记录，验证跨照片稳定 ID 对应。', severityText: '较重', responsiblePartyText: '现场负责人' }
    ]
  };

  const grouped = groupItemsByImage(report.items, report.photos);
  assert.equal(grouped.length, 4);
  assert.deepEqual(grouped.map(group => group.items.length), [2, 0, 1, 0]);
  assert.deepEqual(grouped.map(group => group.imageUrl), photoUrls);

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
      const index = photoUrls.indexOf(request.url());
      if (request.url() === logoUrl) {
        request.respond({ status: 200, contentType: 'image/png', body: fs.readFileSync(logoFile) });
        return;
      }
      if (index >= 0) {
        request.respond({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(photoFiles[index]) });
        return;
      }
      request.abort();
    });
    await page.setContent(buildReportHtml(report), { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');

    assert.match(await page.$eval('.header', node => node.textContent), /示例市示例家具有限公司/);
    assert.match(await page.$eval('.document-meta', node => node.textContent), /13900000000/);
    assert.equal(await page.$$eval('.photo', nodes => nodes.length), 4);
    assert.equal(await page.$$eval('.logo', nodes => nodes.length), 1);
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
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    output,
    realPhotos: photoFiles.map((file, index) => ({ file, sha256_16: digest(file), url: photoUrls[index] })),
    logo: { file: logoFile, sha256_16: digest(logoFile) },
    groups: [2, 0, 1, 0],
    assertion: 'actual JPEG bytes rendered by legacy PDF compatibility template; stable photo IDs retained; company logo rendered; no image failures or horizontal overflow',
    onlineAnnotationNumbersVerified: false
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
