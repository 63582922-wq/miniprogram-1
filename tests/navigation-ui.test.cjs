const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadTabBar(route = "pages/project/list/index") {
  let config;
  const switched = [];
  let currentRoute = route;
  const filename = path.resolve(__dirname, "../miniprogram/custom-tab-bar/index.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    Component(value) { config = value; },
    getCurrentPages() { return [{ route: currentRoute }]; },
    wx: {
      switchTab(options) {
        switched.push(options.url);
        if (options.success) options.success();
      }
    }
  });
  const bar = {
    ...config.methods,
    data: structuredClone(config.data),
    setData(patch) { Object.assign(this.data, patch); }
  };
  return {
    bar,
    switched,
    attached: config.lifetimes.attached.bind(bar),
    show: config.pageLifetimes.show.bind(bar),
    setRoute(value) { currentRoute = value; }
  };
}

test("three-tab navigation follows the visible page and ignores a repeated current-tab tap", () => {
  const fixture = loadTabBar();
  fixture.attached();
  assert.equal(fixture.bar.data.list.length, 3);
  assert.equal(fixture.bar.data.selected, "pages/project/list/index");

  fixture.bar.switchTab({ currentTarget: { dataset: { path: "pages/project/list/index" } } });
  assert.deepEqual(fixture.switched, []);

  fixture.bar.switchTab({ currentTarget: { dataset: { path: "pages/report/list/index" } } });
  assert.deepEqual(fixture.switched, ["/pages/report/list/index"]);
  assert.equal(fixture.bar.data.selected, "pages/report/list/index");

  fixture.setRoute("pages/profile/index");
  fixture.show();
  assert.equal(fixture.bar.data.selected, "pages/profile/index");
});

test("tab pages explicitly synchronize the custom tab bar on every show", () => {
  const { syncTabBar } = require("../miniprogram/utils/tab-bar");
  const patches = [];
  const tabBar = {
    data: { selected: "" },
    setData(patch) {
      patches.push(patch);
      Object.assign(this.data, patch);
    }
  };
  const page = { route: "pages/report/list/index", getTabBar: () => tabBar };
  assert.equal(syncTabBar(page), true);
  assert.deepEqual(patches, [{ selected: "pages/report/list/index" }]);
  assert.equal(syncTabBar(page), true);
  assert.equal(patches.length, 1);

  [
    ["project/list", "pages/project/list/index"],
    ["report/list", "pages/report/list/index"],
    ["profile", "pages/profile/index"]
  ].forEach(([folder, route]) => {
    const source = fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${folder}/index.js`), "utf8");
    assert.match(source, new RegExp(`syncTabBar\\(this,\\s*["]${route.replaceAll("/", "\\/")}["]\\)`));
  });
});

test("editorial type is limited to Chinese object titles", () => {
  const { usesEditorialTypeface } = require("../miniprogram/utils/format");
  assert.equal(usesEditorialTypeface("云栖里 · 木作验收"), true);
  assert.equal(usesEditorialTypeface("QA-0922-B"), false);
  assert.equal(usesEditorialTypeface("1203"), false);
});

test("global visual contract keeps one paper, ink and vermilion system", () => {
  const tokens = fs.readFileSync(path.resolve(__dirname, "../miniprogram/styles/precision-a.wxss"), "utf8");
  const appConfig = fs.readFileSync(path.resolve(__dirname, "../miniprogram/app.json"), "utf8");
  const appStyles = fs.readFileSync(path.resolve(__dirname, "../miniprogram/app.wxss"), "utf8");
  const annotation = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/annotation-canvas/index.wxss"), "utf8");
  const annotationMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/annotation-canvas/index.wxml"), "utf8");
  const annotationScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/annotation-canvas/index.js"), "utf8");
  const annotationPageMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/annotate/index.wxml"), "utf8");
  const annotationPageScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/annotate/index.js"), "utf8");
  const pageNav = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/page-nav-bar/index.wxss"), "utf8");
  const capture = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/create/index.wxss"), "utf8");
  const tabBar = fs.readFileSync(path.resolve(__dirname, "../miniprogram/custom-tab-bar/index.wxss"), "utf8");
  const profile = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/profile/index.wxss"), "utf8");
  const report = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/detail/index.wxss"), "utf8");
  const brandSymbol = fs.readFileSync(path.resolve(__dirname, "../miniprogram/images/brand/haoli-symbol-v8.svg"), "utf8");
  const brandAppSymbol = fs.readFileSync(path.resolve(__dirname, "../miniprogram/images/brand/haoli-symbol-v8-app.svg"), "utf8");
  const reportMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/detail/index.wxml"), "utf8");
  const reportScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/detail/index.js"), "utf8");
  const reviewMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/result/index.wxml"), "utf8");
  const issueMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/inspection-item-card/index.wxml"), "utf8");
  const settingsMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/index.wxml"), "utf8");
  const settingsScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/index.js"), "utf8");
  const productIdentity = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/product-identity/index.wxml"), "utf8");
  const welcomeMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/welcome/index.wxml"), "utf8");
  const captureMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/create/index.wxml"), "utf8");
  const onboardingMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/onboarding/index.wxml"), "utf8");
  const galleryMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/gallery/index.wxml"), "utf8");
  const reportListMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/list/index.wxml"), "utf8");
  const projectDetailMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/detail/index.wxml"), "utf8");
  const projectDetailScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/detail/index.js"), "utf8");
  const voiceMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/voice-recorder/index.wxml"), "utf8");
  const emptyMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/empty-state/index.wxml"), "utf8");
  const projectFormMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/form/index.wxml"), "utf8");
  const projectFormScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/form/index.js"), "utf8");
  const logoUploader = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/logo-uploader/index.js"), "utf8");
  const master = fs.readFileSync(path.resolve(__dirname, "../docs/redesign-2026-09-20/convergence-master.html"), "utf8");
  const pdfTemplate = fs.readFileSync(path.resolve(__dirname, "../report-pdf-service/src/report-template.js"), "utf8");
  const legacyTokens = fs.readFileSync(path.resolve(__dirname, "../miniprogram/styles/tokens.wxss"), "utf8");
  const legacyTheme = fs.readFileSync(path.resolve(__dirname, "../miniprogram/constants/theme.js"), "utf8");
  const componentStylePaths = [
    "annotation-canvas",
    "empty-state",
    "inspection-item-card",
    "logo-uploader",
    "page-nav-bar",
    "product-identity",
    "project-card",
    "report-section",
    "voice-recorder"
  ].map((name) => path.resolve(__dirname, `../miniprogram/components/${name}/index.wxss`));
  const componentStyles = componentStylePaths.map((filename) => fs.readFileSync(filename, "utf8"));
  const allWxss = fs.readdirSync(path.resolve(__dirname, "../miniprogram"), { recursive: true })
    .filter((filename) => filename.endsWith(".wxss"))
    .map((filename) => fs.readFileSync(path.resolve(__dirname, "../miniprogram", filename), "utf8"))
    .join("\n");

  assert.match(tokens, /--a-paper:#E9E4DD/);
  assert.match(tokens, /--a-ink:#191816/);
  assert.match(tokens, /--a-photo-matte:#DDD6CC/);
  assert.match(tokens, /--a-type-caption:26rpx/);
  assert.match(tokens, /--a-accent-text:#B74F2D/);
  assert.doesNotMatch(tokens, /--a-brand:/);
  assert.match(tokens, /--a-font-display:/);
  assert.match(tokens, /--a-font-body:/);
  assert.doesNotMatch(brandSymbol + brandAppSymbol, /#103B36|#243B38|#143D38|#0D3B3E/);
  assert.match(brandSymbol, /fill="#191816"/);
  assert.match(brandSymbol, /fill="#DE6E3F"/);
  assert.match(productIdentity, /现场记录 · 精准标注 · 清楚交付/);
  assert.doesNotMatch(productIdentity, /报告分享/);
  assert.match(welcomeMarkup, /现场记录 · 精准标注 · 清楚交付/);
  assert.match(welcomeMarkup, /<page-nav-bar title=""/);
  assert.equal((welcomeMarkup.match(/毫厘智管/g) || []).length, 1);
  assert.match(welcomeMarkup, /<checkbox-group[^>]+bindchange="handleAgreeChange"/);
  assert.match(welcomeMarkup, /<button class="welcome-link"/);
  assert.match(appStyles, /button,input,textarea\{font-family:var\(--a-font-body\)\}/);
  assert.match(appStyles, /\.section-title\{font-family:var\(--a-font-body\);font-size:34rpx;font-weight:600/);
  componentStyles.forEach((styles) => assert.match(styles, /font-family:\s*var\(--a-font-body/));
  assert.match(annotation, /\.canvas-stage[\s\S]*background: var\(--a-photo-matte\)/);
  assert.match(annotation, /\.annotation-tool-rail,[\s\S]*background: var\(--a-paper\)/);
  assert.doesNotMatch(annotation, /annotation-(?:tool-rail|subrail|nudge)[^}]*background:\s*var\(--a-brand\)/);
  assert.match(annotationMarkup, /原图已适配/);
  assert.match(annotationMarkup, /<text>框选<\/text>/);
  assert.match(annotationMarkup, /<text>圈选<\/text>/);
  assert.match(annotationMarkup, /<text>全图<\/text>/);
  assert.doesNotMatch(annotationMarkup, /<text>矩形<\/text>|<text>圆形<\/text>|<text>适应<\/text>/);
  assert.match(annotationScript, /triggerEvent\("ready"/);
  assert.match(annotationScript, /loadToken!==this\.loadToken/);
  assert.match(annotationPageMarkup, /bindready="handleEditorReady"/);
  assert.match(annotationPageMarkup, /disabled="\{\{saving \|\| !editorReady\}\}"/);
  assert.match(annotationPageScript, /照片还在加载，请稍候/);
  assert.match(pageNav, /background:var\(--a-paper\)/);
  assert.doesNotMatch(pageNav, /rgba\(246,241,232/);
  assert.match(capture, /issue-draft-card__media\{[^}]*background:var\(--a-surface\)/);
  assert.match(capture, /\.capture-section__title\{font-family:var\(--a-font-body\);font-size:38rpx;font-weight:600/);
  assert.match(capture, /\.create-card__section-title\{font-family:var\(--a-font-body\);font-size:34rpx;font-weight:600/);
  assert.doesNotMatch(allWxss, /#143D38|#17211D|#0D3B3E/);
  const fontDeclarations = [...allWxss.matchAll(/font-family:\s*([^;}]+)/g)].map((match) => match[1]);
  fontDeclarations.forEach((value) => assert.match(value, /var\(--a-font-(?:body|display)/));
  const undersizedType = [...allWxss.matchAll(/font-size:\s*(\d+)rpx/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value < 26);
  assert.deepEqual(undersizedType, []);
  assert.match(tabBar, /background:var\(--a-paper\)/);
  assert.match(tabBar, /is-selected[^}]*color:var\(--a-ink\)/);
  assert.match(appConfig, /images\/icons\/icon-tab-project\.png/);
  assert.match(appConfig, /images\/icons\/icon-tab-report\.png/);
  assert.match(appConfig, /images\/icons\/icon-tab-profile\.png/);
  assert.match(appConfig, /"color": "#706D67"/);
  assert.doesNotMatch(appConfig, /business(?:-active)?\.png|examples(?:-active)?\.png|usercenter(?:-active)?\.png/);
  assert.doesNotMatch(allWxss, /background(?:-color)?\s*:\s*var\(--a-brand\)/);
  assert.doesNotMatch([tokens, appConfig, tabBar].join("\n"), /#143D38/);
  ["project", "report", "profile"].forEach((name) => {
    const icon = fs.readFileSync(path.resolve(__dirname, `../miniprogram/images/icons/icon-tab-${name}-active.svg`), "utf8");
    const inactiveIcon = fs.readFileSync(path.resolve(__dirname, `../miniprogram/images/icons/icon-tab-${name}.svg`), "utf8");
    assert.match(icon, /stroke="#191816"/);
    assert.doesNotMatch(icon, /fill="#191816"/);
    assert.match(inactiveIcon, /stroke="#706D67"/);
    assert.doesNotMatch(icon + inactiveIcon, /#143D38|#77766F/);
  });
  assert.match(legacyTokens, /--color-active: #191816/);
  assert.match(legacyTokens, /--color-active-bg: #E2DCD3/);
  assert.doesNotMatch(legacyTheme, /active:\s*'#143D38'|activeBg:\s*'#E7ECE8'|rgba\(26,26,46|rgba\(232,93,4/);
  assert.doesNotMatch(profile, /profile-avatar--empty[^}]*background:var\(--a-brand\)/);
  assert.match(profile, /\.profile-name\{font-family:var\(--a-font-body\);font-size:36rpx;font-weight:600/);
  assert.match(profile, /\.company-card \.section-title\{font-family:var\(--a-font-body\);font-size:32rpx;font-weight:600/);
  assert.doesNotMatch(report, /rgba\(20,61,56/);
  assert.match(report, /\.report-cover__company\s*\{[\s\S]*?font-family:\s*var\(--a-font-body\);[\s\S]*?font-weight:\s*600;/);
  assert.match(report, /\.report-summary__conclusion\s*\{[\s\S]*?font-family:\s*var\(--a-font-body\);[\s\S]*?font-weight:\s*400;/);
  assert.match(report, /padding-bottom:\s*calc\(80px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(reportMarkup, /report\.companyName \|\| '个人出具'/);
  assert.match(reportMarkup, /报告出具人：\{\{report\.publisherName \|\| report\.inspectorName \|\| '未填写'\}\}/);
  assert.match(reportMarkup, /联系电话：\{\{report\.companyPhone \|\| report\.publisherPhone \|\| report\.inspectorPhone\}\}/);
  assert.match(projectDetailMarkup, /继续这次记录/);
  assert.match(projectDetailMarkup, /拍摄现场照片/);
  assert.match(projectDetailMarkup, /class="project-feature__media"/);
  assert.match(projectDetailScript, /getProjectGallery/);
  assert.match(projectDetailMarkup, /bindtap="goNewInspection">新建记录/);
  assert.doesNotMatch(projectDetailScript, /openRecord/);
  assert.match(reviewMarkup, /历史提示/);
  assert.match(issueMarkup, /识别参考/);
  assert.doesNotMatch(reviewMarkup + issueMarkup, /AI 记忆|AI 依据/);
  assert.match(reviewMarkup, /title="人工核对"/);
  assert.match(reviewMarkup, />确认内容</);
  assert.match(reviewMarkup, /bindtap="toggleSummaryEditing"/);
  assert.match(reviewMarkup, /wx:if="\{\{summaryEditing\}\}" class="field-textarea"/);
  assert.match(reviewMarkup, /bindtap="toggleCaptionEditing"/);
  assert.match(reviewMarkup, /未添加现场说明/);
  assert.doesNotMatch(reviewMarkup, /result-guide__icon|result-hint/);
  assert.match(reviewMarkup, /<button[\s\S]+class="issue-entry__delete"/);
  assert.match(captureMarkup, /<button class="issue-draft-card__media-open"[^>]+aria-label=/);
  assert.match(captureMarkup, /issue-draft-card__title">照片/);
  assert.doesNotMatch(captureMarkup, /issue-draft-card__title">问题/);
  assert.match(captureMarkup, /<button class="voice-hold-button[^>]+aria-label=/);
  assert.match(captureMarkup, /wx:if="\{\{issueDraftCount && issueDraftCount < 20\}\}" class="capture-section__add"/);
  assert.match(captureMarkup, /wx:if="\{\{issueDraftCount > 1\}\}" class="issue-order"/);
  assert.ok(captureMarkup.indexOf('class="create-ai-row"') < captureMarkup.indexOf('class="footer-actions create-footer-actions"'));
  assert.match(capture, /\.inspection-create-page\{padding-bottom:calc\(128rpx \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.doesNotMatch(captureMarkup, /<view class="(?:issue-draft-card__(?:collapse|delete|media-action)|create-card__toggle|voice-hold-button|analyze-panel__cancel)"[^>]+bind/);
  assert.match(reportMarkup, /<button[^>]+report-footer__phone/);
  assert.match(reportMarkup, /<button[^>]+report-action-button report-action-button--secondary/);
  assert.doesNotMatch(reportListMarkup, /report-filter__reset/);
  assert.equal((reportListMarkup.match(/bindtap="chooseFilter"/g) || []).length, 1);
  assert.match(onboardingMarkup, /<button class="onboarding-step__tip-trigger"/);
  assert.match(galleryMarkup, /<button class="gallery-card__preview"[^>]+aria-label=/);
  assert.match(voiceMarkup, /<button class="voice-hold-button[^>]+aria-label=/);
  assert.match(emptyMarkup, /<button wx:if="\{\{actionText\}\}" class="empty-state__action"/);
  assert.doesNotMatch(emptyMarkup, /icon-add-inverse|empty-state__icon/);
  assert.match(settingsMarkup, /title="报告资料"/);
  assert.doesNotMatch(settingsMarkup, /page-heading__title/);
  assert.match(settingsMarkup, /wx:elif="\{\{loadError\}\}"/);
  assert.match(settingsScript, /尚未保存资料/);
  assert.match(settingsScript, /savedBase/);
  assert.match(projectFormScript, /pageTitle:"新建项目"/);
  assert.doesNotMatch(projectFormMarkup, /page-heading__title/);
  assert.match(logoUploader, /需要照片权限/);
  assert.match(logoUploader, /openSetting/);
  assert.doesNotMatch(master, /var\(--petrol\)|当前状态<\/span><span>深墨绿/);
  assert.match(master, /tab\.is-current\{color:var\(--ink\)/);
  assert.match(master, /记录 · 标注 · 报告/);
  assert.match(master, /\.report-group-title\{[^}]*font-family:var\(--body\)[^}]*font-weight:600/);
  assert.match(master, /class="report-group-title">问题 一/);
  assert.match(reportScript, /本次已确认 \$\{stats\.total\} 项问题/);
  assert.doesNotMatch(reportScript, /本次共发现问题/);
  assert.match(reportMarkup, />下载 PDF</);
  assert.doesNotMatch(reportMarkup, /已确认 · \{\{report\.severityStats\.total\}\}/);
  assert.match(pdfTemplate, /--paper:#E9E4DD/);
  assert.match(pdfTemplate, /--ink:#191816/);
  assert.match(pdfTemplate, /--accent:#DE6E3F/);
  assert.match(pdfTemplate, /Songti SC/);
  assert.doesNotMatch(pdfTemplate, /#232920|#D6DACF|#F0F2EA|证据位置/);
});
