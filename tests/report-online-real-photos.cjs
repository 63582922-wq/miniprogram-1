// Offline integration check of the production online-report page model with
// the real JPEGs supplied in Downloads. This does not call cloud services or
// create a PDF; it verifies image identity, mobile thumbnail geometry, and
// photo-marker-to-issue correspondence before a device share test.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const photoRoot = '/Users/cft/Downloads/毫厘智管测试测试图';
const photoNames = [
  '0a96236feb4b32cecff83d346eead830.jpeg',
  '4f577062fcf4a9621bfa7a3d1d256469.jpeg',
  'abc961ab7a90e4b74a33c12b610adc71.jpeg',
  'fPtsF97l7.jpeg'
];
const photoFiles = photoNames.map(name => path.join(photoRoot, name));
const pageFile = path.join(root, 'miniprogram/pages/report/detail/index.js');
const reportWxml = fs.readFileSync(path.join(root, 'miniprogram/pages/report/detail/index.wxml'), 'utf8');
let pageConfig;
const sandbox = {
  Page: config => { pageConfig = config; },
  wx: {},
  console,
  Date,
  Math,
  Promise,
  setTimeout,
  clearTimeout,
  getApp: () => ({ globalData: {} }),
  require: name => require(path.resolve(path.dirname(pageFile), name))
};

function dimensions(file) {
  const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(output)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(output)?.[1]);
  assert.ok(width > 0 && height > 0, `could not read actual JPEG dimensions: ${file}`);
  return { width, height };
}

const pageContext = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(pageFile, 'utf8'), pageContext);

async function main() {
  const photoInfo = photoFiles.map(file => {
    assert.equal(fs.existsSync(file), true, `real test photo missing: ${file}`);
    const bytes = fs.readFileSync(file);
    assert.deepEqual(Array.from(bytes.subarray(0, 2)), [0xff, 0xd8], `not a JPEG: ${file}`);
    return {
      id: `real-photo-${photoFiles.indexOf(file) + 1}`,
      file,
      sha256_16: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      ...dimensions(file)
    };
  });
  const annotationRows = [
    { id: 'point-1', type: 'point', a: { x: 0.13, y: 0.21 }, b: { x: 0.18, y: 0.26 } },
    { id: 'point-2', type: 'point', a: { x: 0.49, y: 0.52 }, b: { x: 0.55, y: 0.58 } },
    { id: 'point-3', type: 'point', a: { x: 0.82, y: 0.73 }, b: { x: 0.87, y: 0.79 } }
  ];
  const photos = photoInfo.map((photo, index) => ({
    id: photo.id,
    sourceIndex: index,
    imagePath: photo.file,
    annotations: index === 0 ? annotationRows : []
  }));
  const items = annotationRows.map((annotation, index) => ({
    id: `issue-${index + 1}`,
    sourcePhotoId: photoInfo[0].id,
    annotationId: annotation.id,
    markerNumber: index + 1,
    subIssueIndex: index + 1,
    severity: 'normal',
    description: `真实照片对应问题 ${index + 1}`
  }));

  const report = pageContext.buildReportDisplayState({
    _id: 'isolated-real-photo-report',
    projectName: '隔离真实照片报告验收',
    publishedAt: Date.UTC(2026, 8, 29),
    photos,
    items
  });
  const page = {
    data: { report },
    reportPreviewGeneration: 1,
    setData(values) {
      for (const [key, value] of Object.entries(values)) {
        if (key.startsWith('report.')) {
          const field = key.slice('report.'.length);
          this.data.report = { ...this.data.report, [field]: value };
        } else this.data[key] = value;
      }
    }
  };

  const dimensionsByPath = new Map(photoInfo.map(photo => [photo.file, photo]));
  const wx = {
    getWindowInfo: () => ({ windowWidth: 375 }),
    getImageInfo: ({ src, success, fail }) => {
      const info = dimensionsByPath.get(src);
      if (info) success({ width: info.width, height: info.height });
      else fail(new Error(`unexpected report image path: ${src}`));
    }
  };
  // The production method only needs the mini-program's image metadata API;
  // all paths here are local files and no cloud URL or network call is used.
  const resolveMethod = pageConfig.resolveReportPreviewMedia;
  const originalWx = sandbox.wx;
  sandbox.wx = wx;
  try {
    await resolveMethod.call(page, 1, report);
  } finally {
    sandbox.wx = originalWx;
  }

  const groups = page.data.report.issueGroups;
  assert.equal(page.data.report.photoCount, photoInfo.length);
  assert.equal(JSON.stringify(groups.map(group => group.image)), JSON.stringify(photoFiles));
  assert.equal(JSON.stringify(groups.map(group => group.thumbnailHeight)), JSON.stringify(photoInfo.map(photo => Math.round((375 - 2 * 36 * 375 / 750) * photo.height / photo.width * 750 / 375))));
  assert.equal(JSON.stringify(groups[0].markers.map(marker => [marker.number, marker.left, marker.top])), JSON.stringify([
    [1, '13%', '21%'], [2, '49%', '52%'], [3, '82%', '73%']
  ]));
  assert.equal(JSON.stringify(groups[0].issues.map(issue => [issue.displayNo, issue.markerLabel, issue.description])), JSON.stringify([
    ['1.', '照片标注 1', '真实照片对应问题 1'],
    ['2.', '照片标注 2', '真实照片对应问题 2'],
    ['3.', '照片标注 3', '真实照片对应问题 3']
  ]));
  assert.ok(groups.slice(1).every(group => group.issues.length === 0 && group.markers.length === 0), 'zero-issue photos must not inherit another photo markers');
  assert.match(reportWxml, /wx:for="\{\{group\.markers\}\}"[\s\S]*?\{\{marker\.number\}\}/, 'online report WXML must render visible marker numbers');
  assert.match(reportWxml, /\{\{issue\.displayNo\}\}[\s\S]*?\{\{issue\.description\}\}/, 'the online report must list the matching numbered issue text');

  console.log(JSON.stringify({
    result: 'PASS',
    scope: 'production online-report page model; offline only; no PDF/cloud/model calls',
    viewportWidth: 375,
    realPhotos: photoInfo.map(({ id, file, sha256_16, width, height }) => ({ id, file, sha256_16, width, height })),
    firstPhotoMapping: groups[0].issues.map(issue => ({ number: issue.displayNo, marker: issue.markerLabel, description: issue.description, point: issue.markerPoint })),
    zeroIssuePhotoCount: groups.slice(1).length,
    screenshotOrDeviceVerified: false
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
