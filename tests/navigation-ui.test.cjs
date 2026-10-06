const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");

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
  assert.deepEqual(fixture.bar.data.list.map(item => item.selected), [true, false, false]);
  assert.equal(fixture.bar.data.list[0].iconSrc, "/images/icons/icon-tab-project-active.png");

  fixture.bar.switchTab({ currentTarget: { dataset: { path: "pages/project/list/index" } } });
  assert.deepEqual(fixture.switched, []);

  fixture.bar.switchTab({ currentTarget: { dataset: { path: "pages/report/list/index" } } });
  assert.deepEqual(fixture.switched, ["/pages/report/list/index"]);
  assert.equal(fixture.bar.data.selected, "pages/report/list/index");
  assert.deepEqual(fixture.bar.data.list.map(item => item.selected), [false, true, false]);
  assert.equal(fixture.bar.data.list[1].iconSrc, "/images/icons/icon-tab-report-active.png");

  fixture.setRoute("pages/profile/index");
  fixture.show();
  assert.equal(fixture.bar.data.selected, "pages/profile/index");
});

test("tab pages explicitly synchronize the custom tab bar on every show", () => {
  const { syncTabBar } = require("../miniprogram/utils/tab-bar");
  const patches = [];
  const tabBar = {
    data: { selected: "", list: [
      { pagePath: "pages/project/list/index", iconName: "project", activeIconName: "project-active" },
      { pagePath: "pages/report/list/index", iconName: "report", activeIconName: "report-active" },
      { pagePath: "pages/profile/index", iconName: "profile", activeIconName: "profile-active" }
    ] },
    setData(patch) {
      patches.push(patch);
      Object.assign(this.data, patch);
    }
  };
  const page = { route: "pages/report/list/index", getTabBar: () => tabBar };
  assert.equal(syncTabBar(page), true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].selected, "pages/report/list/index");
  assert.deepEqual(patches[0].list.map(item => item.selected), [false, true, false]);
  assert.equal(patches[0].list[1].iconSrc, "/images/icons/icon-tab-report-active.png");
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

test("report rows keep identifying details but omit the repeated published state", () => {
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/list/index.wxml"), "utf8");
  const style = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/list/index.wxss"), "utf8");
  assert.match(markup, /class="report-row__title object-list-title">\{\{item\.displayTitle\}\}/);
  assert.match(markup, /class="report-row__meta"><text>\{\{item\.reportNo\}\}<\/text>[\s\S]*?\{\{item\.generatedAtDisplay\}\}/);
  assert.match(markup, /class="report-row__metrics">\{\{item\.summaryDisplay\}\}/);
  assert.match(markup, /item\.shareState === 'revoked'[\s\S]*?分享已撤销/);
  assert.doesNotMatch(markup, /已发布\s*·\s*在线报告/);
  assert.match(style, /\.report-row\s*\{[^}]*padding:var\(--a-space-2\) 0/s, "report rows should use the compact spacing token");
  const projectCard = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/project-card/index.wxml"), "utf8");
  assert.match(projectCard, /class="project-card__name object-list-title">\{\{project\.name\}\}/);
  const globalStyles = fs.readFileSync(path.resolve(__dirname, "../miniprogram/app.wxss"), "utf8");
  assert.match(globalStyles, /\.object-list-title\{[^}]*font-size:var\(--a-type-object\)[^}]*line-height:1\.34[^}]*color:var\(--a-ink\)/);
});

test("editorial type is limited to Chinese object titles", () => {
  const { usesEditorialTypeface } = require("../miniprogram/utils/format");
  assert.equal(usesEditorialTypeface("云栖里 · 木作验收"), true);
  assert.equal(usesEditorialTypeface("QA-0922-B"), false);
  assert.equal(usesEditorialTypeface("1203"), false);
});

test("project list marks only explicitly isolated acceptance fixtures and never hides them", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/project-card/index.js"), "utf8");
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/project-card/index.wxml"), "utf8");
  const config = {formatDate:() => "2026-09-29"};
  vm.runInNewContext(source, {Component(value) { config.value = value; }, require(id) {
    assert.equal(id, "../../utils/format");
    return {formatDate:config.formatDate};
  }});
  const observer = config.value.observers.project;
  const setFlag = project => {
    const data = {};
    observer.call({setData(patch) { Object.assign(data, patch); }}, project);
    return data;
  };
  assert.equal(setFlag({name:"QA-20260929",address:"隔离验收专用，不用于真实工程"}).isTestProject, true);
  assert.equal(setFlag({name:"QA隔离验收-0921",address:"自动化验收专用，不用于真实工程"}).isTestProject, true);
  const legacyQa=setFlag({name:"QA-0922-B",address:"Isolated acceptance test"});
  assert.equal(legacyQa.isTestProject, true);
  assert.equal(legacyQa.displayAddress,"隔离验收专用，不用于真实工程","translate only the exact known test fixture note");
  assert.equal(setFlag({name:"1",address:"1"}).isTestProject, false, "ambiguous legacy records must not be guessed to be test data");
  const customer=setFlag({name:"北岸美庐6-1003",address:"佛山市顺德区乐从镇北岸美庐6-1003"});
  assert.equal(customer.isTestProject, false);
  assert.equal(customer.displayAddress,"佛山市顺德区乐从镇北岸美庐6-1003","preserve user-authored address verbatim");
  assert.match(markup, /wx:for|project-card__test-label/);
  assert.match(markup, /wx:if="\{\{isTestProject\}\}" class="project-card__test-label"/);
  assert.match(source, /isTestProject: project\.testOnly === true \|\| project\.isTestProject === true/);
  assert.match(markup, /project-card__meta">\{\{displayAddress\}\}/);
});

test("project creation is the primary action on the project index, above the secondary list label", () => {
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/list/index.wxml"), "utf8");
  assert.match(markup, /<product-identity title="全部项目"/);
  assert.match(markup, /class="ui-button-reset primary-button project-create-dock__button"[^>]*bindtap="goCreate"[\s\S]*?list-create-action__icon[\s\S]*?nav-plus\.svg[\s\S]*?新建项目/);
  const globalStyles = fs.readFileSync(path.resolve(__dirname, "../miniprogram/app.wxss"), "utf8");
  assert.match(globalStyles, /\.list-create-action\{[^}]*min-height:var\(--a-hit\)[^}]*background:var\(--a-accent\)[^}]*font-size:var\(--a-type-body\)[^}]*font-weight:var\(--a-weight-medium\)/s);
  const inspectionList = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/list/index.wxml"), "utf8");
  assert.match(inspectionList, /class="(?:ui-button-reset )?list-create-action"[^>]*bindtap="goCreate"[\s\S]*?list-create-action__icon[\s\S]*?nav-plus\.svg[\s\S]*?新建记录/);
});

test("inspection-wide optional metadata is outside photo repetition and clearly applies to the whole inspection", () => {
  const markup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/create/index.wxml"), "utf8");
  assert.ok(markup.indexOf('class="create-card"') > markup.indexOf('class="issue-draft-list"'));
  assert.match(markup, /巡查信息（选填）/);
  assert.match(markup, /field-label">报告标题/);
  assert.match(markup, /field-label">现场补充说明/);
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
  const inspectionItemMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/inspection-item-card/index.wxml"), "utf8");
  const pageNav = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/page-nav-bar/index.wxss"), "utf8");
  const capture = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/create/index.wxss"), "utf8");
  const projectList = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/list/index.wxss"), "utf8");
  const tabBar = fs.readFileSync(path.resolve(__dirname, "../miniprogram/custom-tab-bar/index.wxss"), "utf8");
  const profile = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/profile/index.wxss"), "utf8");
  const profileTemplate = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/profile/index.wxml"), "utf8");
  const report = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/detail/index.wxss"), "utf8");
  const review = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/result/index.wxss"), "utf8");
  const reportSection = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/report-section/index.wxss"), "utf8");
  const reportMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/detail/index.wxml"), "utf8");
  const reportScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/detail/index.js"), "utf8");
  const reviewMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/result/index.wxml"), "utf8");
  const issueMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/inspection-item-card/index.wxml"), "utf8");
  const settingsMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/index.wxml"), "utf8");
  const settingsScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/settings/index.js"), "utf8");
  const productIdentity = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/product-identity/index.wxml"), "utf8");
  const welcomeMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/welcome/index.wxml"), "utf8");
  const captureMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/create/index.wxml"), "utf8");
  const projectListMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/list/index.wxml"), "utf8");
  const onboardingMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/onboarding/index.wxml"), "utf8");
  const galleryMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/gallery/index.wxml"), "utf8");
  const galleryScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/gallery/index.js"), "utf8");
  const reportListMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/list/index.wxml"), "utf8");
  const reportListScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/report/list/index.js"), "utf8");
  const projectDetailMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/detail/index.wxml"), "utf8");
  const projectDetailScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/detail/index.js"), "utf8");
  const inspectionDetailMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/detail/index.wxml"), "utf8");
  const inspectionDetailScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/detail/index.js"), "utf8");
  const inspectionListMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/inspection/list/index.wxml"), "utf8");
  const voiceMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/voice-recorder/index.wxml"), "utf8");
  const emptyMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/empty-state/index.wxml"), "utf8");
  const projectFormMarkup = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/form/index.wxml"), "utf8");
  const projectFormScript = fs.readFileSync(path.resolve(__dirname, "../miniprogram/pages/project/form/index.js"), "utf8");
  const logoUploader = fs.readFileSync(path.resolve(__dirname, "../miniprogram/components/logo-uploader/index.js"), "utf8");
  const master = fs.readFileSync(path.resolve(__dirname, "../docs/redesign-2026-09-20/convergence-master.html"), "utf8");
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
  assert.match(tokens, /--a-danger-surface:#F2DDD8/);
  assert.match(tokens, /--a-warning-surface:#F1E5D4/);
  assert.match(tokens, /--a-type-caption:26rpx/);
  assert.match(tokens, /--a-page-inset:36rpx/);
  assert.match(tokens, /--a-icon-sm:32rpx/);
  assert.match(tokens, /--a-icon-lg:48rpx/);
  assert.match(tokens, /--a-hit:44px/);
  assert.match(tokens, /--a-motion:180ms/);
  assert.match(tokens, /--a-logo-company:112rpx/);
  assert.match(tokens, /--a-logo-report:160rpx/);
  assert.match(profile, /\.company-logo\{width:var\(--a-logo-company\);height:var\(--a-logo-company\)/);
  assert.match(review, /\.review-identity__logo\s*\{\s*width:\s*var\(--a-logo-company\);\s*height:\s*var\(--a-logo-company\)/);
  assert.match(report, /\.report-cover__logo\s*\{\s*width:\s*var\(--a-logo-report\);\s*height:\s*var\(--a-logo-report\)/);
  assert.match(tokens, /--a-accent-text:#B74F2D/);
  assert.doesNotMatch(tokens, /--a-brand:/);
  assert.match(tokens, /--a-font-display:/);
  assert.match(tokens, /--a-font-body:/);
  assert.match(productIdentity, /product-identity-spacer/);
  assert.doesNotMatch(productIdentity, /报告分享/);
  assert.match(welcomeMarkup, /现场记录 · 精准标注 · 清楚交付/);
  assert.match(welcomeMarkup, /<page-nav-bar root="\{\{true\}\}"/);
  assert.equal((welcomeMarkup.match(/welcome-wordmark">尺包/g) || []).length, 1);
  assert.match(welcomeMarkup, /<checkbox-group[^>]+bindchange="handleAgreeChange"/);
  assert.match(welcomeMarkup, /<button class="(?:ui-button-reset )?welcome-link"/);
  assert.match(appStyles, /button,input,textarea\{font-family:var\(--a-font-body\);font-weight:var\(--a-weight-regular\)\}/);
  assert.match(appStyles, /\.ui-icon--small\{width:var\(--a-icon-sm\);height:var\(--a-icon-sm\)\}/);
  assert.match(appStyles, /\.ui-disabled\{opacity:var\(--a-state-disabled\)\}/);
  assert.match(appStyles, /\.ui-loading\{opacity:var\(--a-state-loading\)\}/);
  assert.match(welcomeMarkup, /disabled="\{\{loading\}\}"/);
  assert.match(fs.readFileSync(path.join(root, "miniprogram/components/page-nav-bar/index.wxss"), "utf8"), /\.page-nav-bar__title--brand\{font-family:var\(--a-font-body\)/);
  assert.match(fs.readFileSync(path.join(root, "miniprogram/components/product-identity/index.wxss"), "utf8"), /\.product-identity__name\{font-family:var\(--a-font-body\)/);
  assert.match(fs.readFileSync(path.join(root, "miniprogram/pages/welcome/index.wxss"), "utf8"), /\.welcome-wordmark\{font-family:var\(--a-font-body\)/);
  assert.match(fs.readFileSync(path.join(root, "miniprogram/pages/project/detail/index.wxss"), "utf8"), /\.project-hero__title\{[^}]*font-family:var\(--a-font-display\)[^}]*font-weight:var\(--a-weight-regular\)/);
  assert.match(appStyles, /\.section-title\{font-family:var\(--a-font-body\);font-size:var\(--a-type-section\);font-weight:var\(--a-weight-emphasis\)/);
  componentStyles.forEach((styles) => assert.match(styles, /font-family:\s*var\(--a-font-body/));
  assert.match(annotation, /\.canvas-stage[\s\S]*background: var\(--a-photo-matte\)/);
  assert.match(annotation, /\.annotation-tool-rail,[\s\S]*background: var\(--a-paper\)/);
  assert.doesNotMatch(annotation, /annotation-(?:tool-rail|subrail|nudge)[^}]*background:\s*var\(--a-brand\)/);
  assert.match(annotationMarkup, /原图已适配/);
  assert.match(annotationMarkup, /<text>选区<\/text>/);
  assert.match(annotationMarkup, /<text>适配<\/text>/);
  assert.match(annotationMarkup, /data-tool="pan"[\s\S]*?<text>拖图<\/text>/);
  assert.match(annotationMarkup, /bindtap="chooseRegionType"/);
  assert.match(annotationMarkup, /矩形/);
  assert.match(annotationMarkup, /椭圆/);
  assert.match(annotationMarkup, /class="region-choice__sheet"/);
  assert.doesNotMatch(annotationScript, /showActionSheet/);
  assert.doesNotMatch(annotationMarkup, /requestExit|>返回</);
  assert.match(annotationPageMarkup, /bind:backtap="handleBackTap"/);
  assert.match(annotationPageMarkup, /保存标注并返回/);
  assert.match(annotationMarkup, /bindtap="undo"/);
  assert.match(annotationMarkup, /bindtap="redo"/);
  assert.doesNotMatch(annotationMarkup, /<text>删除<\/text>|<text>微调<\/text>|<text>箭头<\/text>|<text>放大<\/text>|<text>全图<\/text>/);
  assert.match(annotationMarkup, /tool === 'pan'[\s\S]*单指拖图 · 双指缩放和移动/);
  assert.match(annotationMarkup, /tool === 'select'[\s\S]*点选标注 · 拖动调整位置或范围/);
  assert.match(annotationScript, /triggerEvent\("ready"/);
  assert.match(annotationScript, /loadToken!==this\.loadToken/);
  assert.match(annotationPageMarkup, /bindready="handleEditorReady"/);
  assert.match(annotationPageMarkup, /disabled="\{\{saving \|\| !editorReady\}\}"/);
  assert.match(annotationPageScript, /照片还在加载，请稍候/);
  assert.match(inspectionItemMarkup, /item-card__field-name">区域/);
  assert.match(inspectionItemMarkup, /item-card__field-value">\{\{item\.area\}\}/);
  assert.match(inspectionItemMarkup, /item-card__field-name">分类/);
  assert.match(inspectionItemMarkup, /item-card__field-name">责任方/);
  assert.match(inspectionItemMarkup, /item-card__field-value">\{\{item\.responsiblePartyName/);
  assert.match(inspectionItemMarkup, /item-card__action item-card__edit/);
  assert.match(reviewMarkup, /wx:if="\{\{summary\.memoryAlerts && summary\.memoryAlerts\.length\}\}" class="result-memory"/);
  assert.match(reviewMarkup, /核对提醒/);
  assert.doesNotMatch(reviewMarkup, /summary\.memoryHint|历史提示/);
  assert.doesNotMatch(componentStyles.find((styles) => styles.includes('.item-card__description')) || '', /\.item-card button/);
  assert.match(pageNav, /background:var\(--a-paper\)/);
  assert.doesNotMatch(pageNav, /rgba\(246,241,232/);
  assert.match(capture, /\.issue-draft-card__media\s*\{[^}]*background:\s*var\(--a-photo-matte\)/s);
  assert.match(capture, /\.capture-section__title\s*\{[^}]*font-size:\s*var\(--a-type-section\);[^}]*font-weight:\s*var\(--a-weight-emphasis\)/s);
  assert.match(capture, /\.create-card__section-title\s*\{[^}]*font-size:\s*var\(--a-type-section\);[^}]*font-weight:\s*var\(--a-weight-emphasis\)/s);
  assert.doesNotMatch(allWxss, /#143D38|#17211D|#0D3B3E/);
  const fontDeclarations = [...allWxss.matchAll(/font-family:\s*([^;}]+)/g)].map((match) => match[1]);
  fontDeclarations.forEach((value) => assert.match(value, /var\(--a-font-(?:body|display)/));
  const undersizedType = [...allWxss.matchAll(/font-size:\s*(\d+)rpx/g)]
    .map((match) => Number(match[1]))
    .filter((value) => value < 26);
  assert.deepEqual(undersizedType, []);
  assert.match(allWxss, /\.empty-state__action\s*\{[\s\S]*?min-height:\s*var\(--a-hit-primary\)/);
  assert.match(allWxss, /\.guide-tip-button\s*\{[\s\S]*?min-height:\s*var\(--a-hit-primary\)/);
  assert.match(annotation, /\.tool\s*\{[\s\S]*?min-height:\s*var\(--a-hit-primary\)/);
  assert.match(annotation, /\.tool--active\s*\{[\s\S]*?background:\s*var\(--a-accent-wash\)/);
  assert.match(capture, /\.voice-hold-button\s*\{[\s\S]*?min-height:\s*var\(--a-hit-voice\)/);
  assert.match(capture, /\.voice-hold-button\s*\{[\s\S]*?background:\s*var\(--a-accent-wash\)/);
  assert.match(capture, /\.voice-hold-button--active\s*\{[\s\S]*?background:\s*var\(--a-accent-strong\)/);
  assert.match(capture, /\.voice-hold-button__copy\s*\{[^}]*align-items:\s*center/);
  assert.match(capture, /\.voice-hold-button--cancel\s*\{[\s\S]*?background:\s*var\(--a-danger\)/);
  for (const selector of ["voice-hold-button", "capture-section__title", "issue-draft-card__image"]) {
    const occurrences = [...capture.matchAll(new RegExp(`(^|\\n)\\.${selector}\\s*\\{`, "g"))];
    assert.equal(occurrences.length, 1, `${selector} has one canonical rule, not cascade patches`);
  }
  assert.match(allWxss, /\.gallery-card__link\s*\{[\s\S]*?min-height:\s*var\(--a-hit\)/);
  assert.doesNotMatch(allWxss, /(?:height|min-height):\s*84rpx/);
  assert.doesNotMatch(allWxss, /\.gallery-card__link\s*\{[\s\S]*?height:\s*44rpx/);
  assert.match(tabBar, /background:\s*var\(--a-paper\)/);
  assert.doesNotMatch(tabBar, /border-top:\s*1px solid var\(--a-line\)/);
  assert.match(tabBar, /is-selected[^}]*color:\s*var\(--a-ink\)/);
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
  assert.match(legacyTokens, /--color-active: var\(--a-active\)/);
  assert.match(legacyTokens, /--color-active-bg: var\(--a-surface\)/);
  assert.doesNotMatch(legacyTheme, /active:\s*'#143D38'|activeBg:\s*'#E7ECE8'|rgba\(26,26,46|rgba\(232,93,4/);
  assert.doesNotMatch(profile, /profile-avatar--empty[^}]*background:var\(--a-brand\)/);
  assert.match(profileTemplate, /profile-avatar__placeholder-icon[\s\S]*icon-tab-profile\.svg/);
  assert.doesNotMatch(profileTemplate, /profile-avatar--empty[^<]*>我</);
  assert.match(profile, /\.profile-avatar__placeholder-icon\{width:46rpx;height:46rpx/);
  assert.match(profile, /\.profile-name\{font-family:var\(--a-font-body\);font-size:var\(--a-type-object\);font-weight:var\(--a-weight-medium\)/);
  assert.match(profile, /\.company-card \.section-title\{font-family:var\(--a-font-body\);font-size:var\(--a-type-body\);font-weight:var\(--a-weight-medium\)/);
  assert.doesNotMatch(report, /rgba\(20,61,56/);
  assert.match(report, /\.report-cover__company\s*\{[\s\S]*?font-family:\s*var\(--a-font-body\);[\s\S]*?font-weight:\s*var\(--a-weight-regular\);/);
  assert.match(report, /\.report-summary__conclusion\s*\{[\s\S]*?font-family:\s*var\(--a-font-body\);[\s\S]*?font-weight:\s*var\(--a-weight-regular\);/);
  assert.match(reportSection, /font-size:\s*var\(--a-type-body\)/);
  assert.match(reportSection, /font-weight:\s*var\(--a-weight-regular\)/);
  assert.match(reportSection, /color:\s*var\(--a-ink\)/);
  assert.match(report, /padding-bottom:\s*calc\(var\(--a-space-report-clearance\) \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(report, /\.report-page \.footer-actions--fixed\s*\{[^}]*padding-left:\s*0;|\.report-page \.footer-actions--fixed\s*\{[^}]*padding-right:\s*0;/);
  assert.match(report, /\.report-delivery-row\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(report, /\.report-page \.footer-actions--fixed > \.report-readonly-hint\s*\{[\s\S]*?width:\s*100%;/);
  assert.match(report, /\.issue__severity--critical\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(report, /\.issue__severity--major\s*\{[\s\S]*?background:\s*transparent/);
  // Online report media resolves from the frozen snapshot. It must no longer
  // prepare a second photo payload for the removed client PDF workflow.
  assert.match(reportScript, /resolveReportPreviewMedia/);
  assert.match(reportScript, /item\.sourcePhotoId/);
  assert.match(captureMarkup, /\{\{analyzeProgressLabel\}\} \{\{analyzeCompletedPhotos\}\} \/ \{\{analyzeTotalPhotos\}\}/);
  assert.match(captureMarkup, /analyzeStageIndex === 1 \? '正在保存照片'/);
  assert.match(reportMarkup, /report\.companyName \|\| '个人巡查'/);
  assert.match(reportMarkup, /巡查单位/);
  assert.match(reportScript, /publisherName !== inspectorName/);
  assert.match(reportScript, /contactEntries/);
  assert.match(reportMarkup, /report\.identityRows/);
  assert.match(reportMarkup, /report\.contactEntries/);
  assert.doesNotMatch(reportMarkup, /单位 \{\{report\.companyPhone\}\}|巡查人 \{\{report\.inspectorPhone\}\}/);
  assert.doesNotMatch(reportMarkup, /\{\{group\.mappingText\}\}/);
  assert.doesNotMatch(reportMarkup, /点击照片，可放大查看并定位问题/);
  assert.match(reportMarkup, /issue-group__content/);
  assert.match(reportMarkup, /report-image-viewer__focus/);
  assert.match(reportMarkup, /src="\{\{group\.image\}\}" mode="aspectFit"/);
  assert.match(reportMarkup, /<image class="issue-group__image"[^>]+data-index="\{\{index\}\}" catchtap="handlePreviewImage"/);
  assert.match(reportMarkup, /class="issue-group__media"[^>]+data-index="\{\{index\}\}" bindtap="handlePreviewImage"/);
  assert.doesNotMatch(reportMarkup, /issue-group__zoom-hint|点图放大/);
  assert.ok(reportMarkup.indexOf('class="issue-group__media"') < reportMarkup.indexOf('class="issue-group__details"'), 'each report photo must precede its same-photo issue descriptions');
  assert.doesNotMatch(reportMarkup, /PDF|pdf|下载报告|下载文件|page-break/);
  assert.match(report, /\.report-page\s*\{[\s\S]*?background-color:\s*var\(--a-paper\)\s*!important/);
  assert.match(report, /\.issue-group__media\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(fs.readFileSync(path.resolve(__dirname,'../miniprogram/components/report-section/index.wxss'),'utf8'), /\.report-section\s*\{[^}]*background:\s*transparent/);
  assert.doesNotMatch(report, /page-break-(?:before|after|inside)|@page\s*\{/);
  assert.doesNotMatch(reportMarkup, /毫厘智管|尺包|report-product-signature/);
  assert.match(reportMarkup, /wx:for="\{\{group\.markers\}\}" wx:for-item="marker"/);
  assert.match(reportMarkup, /previewGroup\.annotatedImage \? 'is-baked'/);
  assert.match(reportMarkup, /!previewGroup\.annotatedImage \|\| issue\.viewerKey === previewGroup\.activeIssueId/);
  assert.match(report, /\.report-image-viewer__focus\.is-baked\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(reportMarkup, /movable-view[^>]+scale-max="4"/);
  assert.match(report, /\.report-page\s*\{[\s\S]*?background:\s*var\(--a-paper\)/);
  assert.match(report, /\.issue__severity--normal\s*\{[\s\S]*?background:\s*transparent/);
  assert.doesNotMatch(reportMarkup, /照片标注 \{\{issue\.markerNumber\}\}/);
  assert.match(reportMarkup, /点问题查看标注/);
  assert.match(reportMarkup, /class="report-cover__meta-item"/);
  assert.match(reportMarkup, /class="report-cover__contact-line"/);
  assert.match(reportMarkup, /class="report-cover__brand-copy"/);
  assert.match(reportMarkup, /class="report-cover__issuer-label">巡查单位/);
  assert.doesNotMatch(reportMarkup, /FIELD REPORT|现场巡查报告/);
  assert.doesNotMatch(report, /\.report-cover__doctype/);
  assert.match(reportMarkup, /class="report-summary__kicker"/);
  assert.doesNotMatch(reportMarkup, /本次范围 · \{\{report\.photoCount\}\} 张照片/);
  assert.match(reportMarkup, /report\.photoCount\}\} 张照片/);
  assert.doesNotMatch(reportMarkup, /report\.severityStats\.total\}\} 项问题/);
  assert.match(reportMarkup, /wx:if="\{\{!group\.issues\.length\}\}" class="issue-group__status">未记录问题/);
  assert.match(reportListMarkup, /class="report-row__meta"><text>\{\{item\.reportNo\}\}<\/text>/);
  assert.match(reportListScript, /reportNo:buildReportNo\(i\)/);
  assert.match(projectDetailMarkup, /开始现场记录/);
  assert.match(projectDetailMarkup, /未完成记录/);
  assert.match(projectDetailMarkup, /bindtap="continueDraft"/);
  assert.doesNotMatch(projectDetailMarkup, /继续这次记录|拍摄现场照片/);
  assert.match(projectDetailScript, /getProjectGallery/);
  assert.match(projectDetailMarkup, /开始现场记录/);
  assert.match(projectDetailMarkup, /bindtap="continueDraft"/);
  assert.doesNotMatch(projectDetailScript, /openRecord/);
  assert.match(inspectionDetailMarkup, /title="现场记录"/);
  assert.match(inspectionDetailMarkup, /历史记录/);
  assert.match(inspectionDetailMarkup, /查看报告/);
  assert.match(inspectionDetailMarkup, /整理并生成报告/);
  assert.match(inspectionDetailMarkup, /bindtap="loadDetail"/);
  assert.match(inspectionDetailScript, /detailLoadGeneration/);
  assert.match(inspectionListMarkup, /page-nav-bar title="\{\{pageTitle \|\| '现场记录'\}\}"/);
  assert.doesNotMatch(inspectionListMarkup, /page-heading__title/, 'the page theme is not repeated below the navigation');
  assert.match(inspectionListMarkup, />新建记录</);
  assert.doesNotMatch(inspectionListMarkup, />开始记录</);
  assert.match(reviewMarkup, /核对提醒/);
  assert.doesNotMatch(reviewMarkup, /历史提示|已结合你的修正习惯/);
  assert.match(issueMarkup, /识别参考/);
  assert.match(issueMarkup, /处理建议/);
  assert.doesNotMatch(issueMarkup, /整改建议/);
  assert.doesNotMatch(reviewMarkup + issueMarkup, /AI 记忆|AI 依据/);
  assert.match(reviewMarkup, /title="人工核对"/);
  assert.match(reviewMarkup, /确认内容并生成报告/);
  assert.match(reviewMarkup, /summary\.issueCount/);
  assert.doesNotMatch(reviewMarkup, /本次小结|toggleSummaryEditing|summaryEditing/);
  assert.match(reviewMarkup, /现场补充说明/);
  assert.doesNotMatch(reviewMarkup, /补充照片说明|添加补充|toggleCaptionEditing|handleCaptionInput/);
  assert.match(reviewMarkup, /现场说明/);
  assert.doesNotMatch(reviewMarkup, /未添加现场说明/);
  assert.match(reviewMarkup, /重新加载照片/);
  assert.doesNotMatch(reviewMarkup, /result-guide__icon|result-hint/);
  assert.match(issueMarkup, /bindtap="deleteItem"/);
  assert.match(reviewMarkup, /binddelete="handleDeleteIssue"/);
  assert.match(captureMarkup, /<view class="issue-draft-card__media-open"[^>]+aria-label=/);
  assert.match(captureMarkup, /class="issue-draft-card__image"[^>]+mode="widthFix"/);
  assert.match(capture, /\.issue-draft-card__image\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*height:\s*auto;/s);
  assert.doesNotMatch(capture, /\.issue-draft-card__image\s*\{[^}]*height:\s*420rpx/s);
  assert.doesNotMatch(captureMarkup, /<button class="issue-draft-card__media-open"/);
  assert.match(captureMarkup, /catchtap="replaceIssueImage"/);
  assert.match(captureMarkup, /issue-draft-card__title">照片/);
  assert.doesNotMatch(captureMarkup, /issue-draft-card__title">问题/);
  assert.match(captureMarkup, /<button class="(?:ui-button-reset )?voice-hold-button[^>]+aria-label=/);
  assert.match(captureMarkup, /<view class="issue-composer">\s*<textarea[\s\S]*?<button class="(?:ui-button-reset )?voice-hold-button/);
  assert.doesNotMatch(captureMarkup, /placeholder="也可以输入说明"/);
  assert.match(captureMarkup, /<text>继续添加<\/text>/);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/inspection/create/index.js'), 'utf8'), /itemList: \["拍照", "从相册选择"\]/);
  assert.match(captureMarkup, /建议横向拍摄，竖图也支持/);
  assert.doesNotMatch(captureMarkup, /拍照或添加照片/);
  assert.doesNotMatch(projectListMarkup, /开始现场记录|project-record-action|selectingProject/);
  assert.match(captureMarkup, /class="capture-section__count">\{\{form\.issueDrafts\.length\}\} \/ 20/);
  assert.match(captureMarkup, /bindtap="handlePhotoMenu"/);
  assert.match(captureMarkup, /wx:if="\{\{form\.issueDrafts\.length > 1\}\}" class="ui-button-reset ui-section-row__action" bindtap="chooseAllPhotoProcessing"/);
  assert.doesNotMatch(captureMarkup, /issueDraftCount/);
  assert.equal((captureMarkup.match(/bindtap="handleContinueReview"/g)||[]).length,1);
  assert.match(captureMarkup, /bindtap="choosePhotoProcessing"/);
  assert.match(captureMarkup, /data-mode="manual" bindtap="choosePhotoProcessing"><image class="photo-choice-option__icon" src="\/images\/icons\/icon-note\.svg"/);
  assert.match(captureMarkup, /data-mode="ai" bindtap="choosePhotoProcessing"><image class="photo-choice-option__icon" src="\/images\/icons\/icon-inspection\.svg"/);
  assert.match(capture, /\.photo-processing-mode--ai \.photo-processing-mode__value\s*\{\s*color:\s*var\(--a-accent-text\)/);
  assert.doesNotMatch(captureMarkup, /issue-analysis-choice__button/);
  assert.match(captureMarkup, /bindtap="recognizePhoto"/);
  assert.match(capture, /\.inspection-create-page\s*\{\s*padding-bottom:\s*calc\(var\(--a-space-capture-clearance\) \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(projectList, /padding-bottom:\s*calc\(var\(--a-hit-tab\) \+ var\(--a-hit-primary\) \+ var\(--a-space-4\) \+ env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(captureMarkup, /<view class="(?:issue-draft-card__(?:collapse|delete|media-action)|create-card__toggle|voice-hold-button|analyze-panel__cancel)"[^>]+bind/);
  assert.doesNotMatch(reportMarkup, /在线报告会保留在你的报告列表中/);
  assert.doesNotMatch(reportMarkup, /report-footer__label">报告编号/);
  assert.doesNotMatch(reportMarkup, /report-footer__label">分享状态/);
  assert.match(reportMarkup, /report-footer__label">出具时间/);
  assert.match(reportMarkup, /巡查日期　\/　\{\{report\.inspectionDateDisplay\}\}/);
  assert.doesNotMatch(reportMarkup, /report\.title \|\| '现场巡查报告'/);
  assert.match(reportMarkup, /open-type="share"/);
  assert.doesNotMatch(reportMarkup, /下载 PDF|重试 PDF|打开 PDF|report-pdf-action/);
  assert.doesNotMatch(reportListMarkup, /report-filter__reset/);
  assert.equal((reportListMarkup.match(/bindtap="chooseFilter"/g) || []).length, 1);
  assert.match(onboardingMarkup, /<button class="(?:ui-button-reset )?onboarding-step__tip-trigger"/);
  assert.match(galleryMarkup, /<button[\s\S]+class="(?:ui-button-reset )?gallery-card__preview"[\s\S]+aria-label=/);
  assert.match(galleryScript, /resolveCloudFileUrls/);
  assert.match(galleryScript, /loadError/);
  assert.doesNotMatch(projectDetailMarkup, /project-progress|项目内容|workspaceStats/);
  assert.match(projectDetailMarkup, /查看全部照片/);
  assert.match(projectDetailMarkup, /最近记录/);
  assert.match(projectDetailMarkup, /最近报告/);
  assert.match(voiceMarkup, /<button class="(?:ui-button-reset )?voice-hold-button[^>]+aria-label=/);
  assert.match(emptyMarkup, /<button wx:if="\{\{actionText\}\}" class="(?:ui-button-reset )?empty-state__action"/);
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
  assert.doesNotMatch(reportMarkup, />下载 PDF</);
  assert.doesNotMatch(reportMarkup, /问题总数/);
  assert.match(reportMarkup, /{{report\.severityStats\.critical}}/);
  assert.match(reportMarkup, /{{report\.severityStats\.major}}/);
  assert.match(reportMarkup, /{{report\.severityStats\.normal}}/);
});

test("report share controls stay inside the paper UI and preserve retry/cancel states", () => {
  const markup = fs.readFileSync(path.join(root, "miniprogram/pages/report/detail/index.wxml"), "utf8");
  const styles = fs.readFileSync(path.join(root, "miniprogram/pages/report/detail/index.wxss"), "utf8");
  const script = fs.readFileSync(path.join(root, "miniprogram/pages/report/detail/index.js"), "utf8");
  assert.match(markup, /class="share-panel-scrim" catchtap="closeSharePanel"/);
  assert.match(markup, /class="share-panel" catchtap="ignoreSharePanelTap"/);
  assert.match(markup, /bindtap="confirmShareAction"/);
  assert.match(markup, /bindtap="closeSharePanel"/);
  assert.match(markup, /class="share-panel__error">\{\{shareActionError\}\}/);
  assert.match(styles, /\.share-panel\s*\{[^}]*background:\s*var\(--a-paper\)/s);
  assert.match(styles, /\.share-panel__button\s*\{[^}]*min-height:\s*var\(--a-hit\)/s);
  assert.match(styles, /background:\s*var\(--a-scrim\)/);
  assert.doesNotMatch(script, /wx\.showActionSheet|wx\.showModal/);
});
