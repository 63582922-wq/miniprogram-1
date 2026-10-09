const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function collectWxss(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectWxss(file));
    else if (file.endsWith('.wxss')) files.push(file);
  }
  return files;
}

function collectWxml(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectWxml(file));
    else if (file.endsWith('.wxml')) files.push(file);
  }
  return files;
}

test('one UI foundation owns colors, font roles and every A token used by app surfaces', () => {
  const foundationPath = path.join(root, 'miniprogram/styles/precision-a.wxss');
  const foundation = fs.readFileSync(foundationPath, 'utf8');
  const app = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8');
  const tabConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/custom-tab-bar/index.json'), 'utf8'));
  const compatibility = fs.readFileSync(path.join(root, 'miniprogram/styles/tokens.wxss'), 'utf8');
  const iconDirectory = path.join(root, 'miniprogram/images/icons');
  const surfaces = [
    path.join(root, 'miniprogram/app.wxss'),
    ...collectWxss(path.join(root, 'miniprogram/pages')),
    ...collectWxss(path.join(root, 'miniprogram/components')),
    path.join(root, 'miniprogram/custom-tab-bar/index.wxss'),
    path.join(root, 'miniprogram/styles/tokens.wxss')
  ];
  const defined = new Set(Array.from(foundation.matchAll(/(--a-[\w-]+)\s*:/g), match => match[1]));
  const used = new Set();

  assert.match(app, /@import\s+["']\.\/styles\/precision-a\.wxss["'];/);
  assert.match(app, /\.ui-button-reset\s*\{[^}]*font-weight\s*:\s*var\(--a-weight-regular\)/s, 'native buttons inherit normal copy weight through the shared semantic class');
  assert.doesNotMatch(app, /(?:^|,)\s*(?:button|input|textarea):focus\b/m, 'the shared app stylesheet must not inject selectors rejected by isolated mini-program pages');
  assert.match(foundation, /\.page\s*,\s*:host\s*,\s*\.custom-tab-bar\s*\{/, 'shared tokens must be available to pages, isolated components and the custom tab bar without unsupported tag selectors');
  assert.match(compatibility, /@import\s+["']\.\/precision-a\.wxss["'];/);
  assert.equal(tabConfig.styleIsolation, 'apply-shared', 'the custom tab bar must receive shared app-level UI tokens');
  assert.doesNotMatch(compatibility, /#[\da-fA-F]{3,8}|font-size\s*:\s*\d+rpx/);

  for (const file of surfaces) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file);
    if (relative.startsWith('miniprogram/components/') || relative.startsWith('miniprogram/custom-tab-bar/')) {
      assert.match(source, /@import\s+["'][^"']*styles\/precision-a\.wxss["'];/, `${relative} must import the shared token source across the component isolation boundary`);
    }
    assert.doesNotMatch(source, /#[\da-fA-F]{3,8}/, `${relative} must use shared color tokens`);
    assert.doesNotMatch(source, /font-weight\s*:\s*(?:400|500|600)\b/, `${relative} must use shared semantic weight roles`);
    if (!file.endsWith('precision-a.wxss')) {
      assert.doesNotMatch(source, /font-size\s*:\s*\d+rpx/, `${relative} must use shared type roles`);
      assert.doesNotMatch(
        source,
        /(?:padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap|border-radius)\s*:[^;{}]*\b-?\d+(?:\.\d+)?(?:rpx|px)/,
        `${relative} must use shared spacing and radius roles`
      );
    }
    for (const match of source.matchAll(/var\((--a-[\w-]+)/g)) used.add(match[1]);
  }

  const missing = [...used].filter(token => !defined.has(token));
  assert.deepEqual(missing, [], `undefined shared tokens: ${missing.join(', ')}`);
  const iconPalette = new Set(['--a-ink', '--a-muted', '--a-ink-inverse'].map(role => {
    const match = foundation.match(new RegExp(`${role}\\s*:\\s*(#[\\da-fA-F]{3,8})`));
    assert.ok(match, `icon palette must define ${role}`);
    return match[1].toLowerCase();
  }));
  const iconFiles = fs.readdirSync(iconDirectory).filter(file => file.endsWith('.svg'));
  assert.ok(iconFiles.length > 0, 'the product must use its checked-in vector icon system');
  for (const file of iconFiles) {
    const source = fs.readFileSync(path.join(iconDirectory, file), 'utf8');
    assert.doesNotMatch(source, /(?:fill|stroke)="(?:black|white|currentColor)"|fill-opacity=/i, `${file} must not use untracked platform-default colors or opacity-based variants`);
    const colors = [...source.matchAll(/(?:fill|stroke)="(#[\\da-fA-F]{3,8})"/g)].map(match => match[1].toLowerCase());
    for (const color of colors) {
      assert.ok(iconPalette.has(color), `${file} contains ${color}, outside the semantic icon palette`);
      if (color === iconPalette.values().next().value) continue;
      assert.ok(file.includes('inverse') || color !== [...iconPalette][2], `${file} may use inverse ink only when explicitly named inverse`);
    }
  }
  for (const role of [
    '--a-paper', '--a-ink', '--a-ink-inverse', '--a-muted', '--a-line', '--a-accent',
    '--a-font-body', '--a-font-display', '--a-type-body', '--a-type-caption',
    '--a-space-1', '--a-space-3', '--a-space-tab-clearance',
    '--a-radius-control', '--a-radius-object', '--a-radius-pill', '--a-hit', '--a-motion',
    '--a-weight-regular', '--a-weight-medium', '--a-weight-emphasis',
    '--a-hit-compact', '--a-hit-primary', '--a-hit-review', '--a-hit-voice', '--a-hit-row'
  ]) assert.ok(defined.has(role), `missing required design role ${role}`);
  assert.match(foundation, /--a-weight-regular:300/);
  assert.match(foundation, /--a-weight-medium:400/);
  assert.match(foundation, /--a-weight-emphasis:400/, 'hierarchy uses size, spacing and color instead of heavier text');
  assert.match(foundation, /--a-hit:\s*44px/);
  assert.match(foundation, /--a-hit-compact:\s*48px/);
  assert.match(foundation, /--a-hit-primary:\s*52px/);
  assert.match(foundation, /--a-hit-review:\s*56px/);
  assert.match(foundation, /--a-hit-voice:\s*60px/);
  assert.match(foundation, /--a-hit-row:\s*64px/);
  const baseSpacing = [...foundation.matchAll(/--a-space-(\d+)\s*:\s*(\d+)rpx/g)];
  assert.deepEqual(baseSpacing.map(([, step, value]) => [Number(step), Number(value)]), [
    [1, 8], [2, 16], [3, 24], [4, 32], [5, 40], [6, 48], [7, 56], [8, 64], [10, 80], [15, 120]
  ], 'the shared spacing scale uses 4 CSS-pixel increments and deliberate larger jumps');
  const typeScale = [...new Set([...foundation.matchAll(/--a-type-[\w-]+\s*:\s*(\d+)rpx/g)].map(([, size]) => Number(size)))].sort((a, b) => a - b);
  assert.deepEqual(typeScale, [26, 28, 30, 32, 36, 48, 60], 'semantic type roles must resolve to the seven approved type sizes, not accumulate near-duplicate sizes');
  assert.doesNotMatch(foundation, /--a-space-(?:\d+-\d+|0-\d+)\s*:/, 'the base spacing system must not reintroduce fractional one-off steps');
  for (const file of surfaces) {
    const source = fs.readFileSync(file, 'utf8');
    const relative = path.relative(root, file);
    assert.doesNotMatch(source, /min-height\s*:\s*(?:44|48|52|56|60)px\b/, `${relative} must use a named touch-size role rather than a private hit target`);
  }
});

test('inspection issue card has one canonical rule per visual role, without end-of-file style overrides', () => {
  const source = fs.readFileSync(path.join(root, 'miniprogram/components/inspection-item-card/index.wxss'), 'utf8');
  const selectors = [
    '.item-card__header-main', '.item-card__index', '.item-card__field-grid',
    '.item-card__input', '.item-card__textarea', '.item-card__picker',
    '.item-card__summary-meta', '.item-card__field-line', '.item-card__action',
    '.item-card__source', '.item-card__source-toggle', '.item-card__source-quote'
  ];
  for (const selector of selectors) {
    const escaped = selector.replaceAll('.', '\\.');
    const occurrences = [...source.matchAll(new RegExp(`${escaped}\\s*(?=[,{])`, 'g'))];
    const expected = selector === '.item-card__textarea' ? 2 : 1;
    assert.equal(occurrences.length, expected, `${selector} must have one canonical rule${expected === 2 ? ' plus its explicit textarea sizing rule' : ''}`);
  }
});

test('inspection review page keeps canonical typography, identity, image and issue-spacing rules', () => {
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/result/index.wxss'), 'utf8');
  for (const selector of [
    '.review-identity', '.review-identity__company', '.review-identity__edit',
    '.result-group__title', '.result-group__image', '.result-photo-actions',
    '.result-caption', '.issue-entry + .issue-entry'
  ]) {
    const escaped = selector.replaceAll('.', '\\.').replaceAll('+', '\\+');
    const occurrences = [...source.matchAll(new RegExp(`^${escaped}\\s*\\{`, 'gm'))];
    assert.equal(occurrences.length, 1, `${selector} must have one canonical rule, not a trailing visual override`);
  }
});

test('the UI system defines reusable page grammar and shared base components, not only palette tokens', () => {
  const spec = fs.readFileSync(path.join(root, 'docs/设计系统-精密工程-A-2026-09-29.md'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8');

  for (const section of [
    '## 全局版式合同', '### 页面骨架', '### 排版与对齐', '### 容器与内容密度',
    '### 图标与动态反馈', '### 关键页面模板', '现场采集', '人工核对', '在线报告',
    'AI只负责从这段说明整理区域、分类、责任方等结构化候选'
  ]) assert.ok(spec.includes(section), `UI system contract must define ${section}`);

  for (const primitive of [
    '.page{', '.card{', '.section-title{', '.section-subtitle{',
    '.primary-button{', '.secondary-button{', '.field{', '.footer-actions--fixed{',
    '.ui-status', '.ui-disabled', '.is-pressed'
  ]) assert.ok(app.includes(primitive), `shared app component grammar must provide ${primitive}`);
});

test('annotation toolbar disabled-state styling uses a mini-program-safe semantic class selector', () => {
  const style = fs.readFileSync(path.join(root, 'miniprogram/components/annotation-canvas/index.wxss'), 'utf8');
  const markup = fs.readFileSync(path.join(root, 'miniprogram/components/annotation-canvas/index.wxml'), 'utf8');
  assert.match(style, /\.tool--disabled\s*\{[^}]*opacity\s*:/s);
  assert.doesNotMatch(style, /\[[^\]]+\]/, 'component WXSS must not use unsupported attribute selectors');
  assert.match(markup, /disabled="\{\{!canUndo\}\}" bindtap="undo"/);
  assert.match(markup, /disabled="\{\{!canRedo\}\}" bindtap="redo"/);
});

test('UI spacing, disabled and pressed states use shared roles; page/component styles avoid unsupported element selectors', () => {
  const foundation = fs.readFileSync(path.join(root, 'miniprogram/styles/precision-a.wxss'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8');
  assert.match(foundation, /--a-state-disabled:\.42/);
  assert.match(foundation, /--a-state-loading:\.76/);
  assert.match(foundation, /--a-state-pressed:\.68/);
  assert.doesNotMatch(app, /\[(?:disabled|loading)\]/, 'shared state appearance must use classes; native attributes remain for behavior');
  assert.doesNotMatch(app, /\.page-heading\s+\.section-subtitle/, 'global styles must not use an unused descendant selector across isolated pages');
  assert.doesNotMatch(app, /button,\.primary-button/, 'global transition rules must not begin with a native type selector rejected by the mini-program compiler');
  assert.match(app, /\.ui-button-reset\s*\{[^}]*padding:0[^}]*background:transparent/s, 'native button reset must use a shared semantic class instead of a tag selector');
  for (const file of collectWxml(path.join(root, 'miniprogram'))) {
    const markup = fs.readFileSync(file, 'utf8');
    const buttonCount = [...markup.matchAll(/<button(?=[\s>])/g)].length;
    const resetCount = [...markup.matchAll(/class="[^"]*\bui-button-reset\b[^"]*"/g)].length;
    assert.equal(resetCount, buttonCount, `${path.relative(root, file)} must apply the shared native button reset to every button`);
  }
  for (const file of [...collectWxss(path.join(root, 'miniprogram/pages')), ...collectWxss(path.join(root, 'miniprogram/components'))]) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/([^{}]+)\{/g)) {
      const selectorGroup = match[1].trim();
      if (selectorGroup.startsWith('@')) continue;
      for (const selector of selectorGroup.split(',')) {
        assert.doesNotMatch(selector.trim(), /(^|[\s>+~])(page|button|view|text|image|input|textarea|scroll-view|swiper|swiper-item)(?=$|[\s>+~:#.[\\])/,
          `${path.relative(root, file)} uses a type selector unsupported in isolated page/component WXSS: ${selector.trim()}`);
      }
    }
  }
  for (const file of [
    path.join(root, 'miniprogram/pages/inspection/create/index.wxml'),
    path.join(root, 'miniprogram/pages/inspection/annotate/index.wxml'),
    path.join(root, 'miniprogram/pages/inspection/result/index.wxml'),
    path.join(root, 'miniprogram/pages/project/form/index.wxml'),
    path.join(root, 'miniprogram/pages/settings/index.wxml'),
    path.join(root, 'miniprogram/pages/welcome/index.wxml'),
    path.join(root, 'miniprogram/components/annotation-canvas/index.wxml')
  ]) {
    const markup = fs.readFileSync(file, 'utf8');
    for (const button of markup.matchAll(/<button\b[^>]*\bdisabled="[^\"]*"[^>]*>/g)) {
      assert.match(button[0], /ui-disabled|tool--disabled/, `${path.relative(root, file)} must pair native disabled behavior with the shared visible disabled state`);
    }
  }
});

test('interactive list rows and source-choice rows share one tactile height role', () => {
  const foundation = fs.readFileSync(path.join(root, 'miniprogram/styles/precision-a.wxss'), 'utf8');
  const capture = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxss'), 'utf8');
  const project = fs.readFileSync(path.join(root, 'miniprogram/pages/project/detail/index.wxss'), 'utf8');
  assert.match(foundation, /--a-hit-row:\s*64px/);
  assert.match(capture, /\.photo-choice-option\s*\{[^}]*min-height:\s*var\(--a-hit-row\)/s);
  assert.match(project, /\.project-plain-row\s*\{[^}]*min-height:\s*var\(--a-hit-row\)/s);
});

test('report photo groups use spacing instead of decorative horizontal rules', () => {
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/report/detail/index.wxss'), 'utf8');
  const match = source.match(/\.issue-group\s*\{([^}]*)\}/s);
  assert.ok(match, 'report photo group must have an explicit layout rule');
  assert.doesNotMatch(match[1], /border-top\s*:\s*1px\s+solid\s+var\(--a-line\)/, 'photo groups should not look like ruled notebook pages');
  assert.doesNotMatch(match[1], /border-top\s*:\s*\d+(?:\.\d+)?px\s+solid\s+var\(--a-ink\)/, 'do not overpower the evidence with a heavy ink divider');
});

test('voice recording is a prominent secondary action; the page CTA owns the solid accent fill', () => {
  const capture = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxss'), 'utf8');
  const voice = capture.match(/\.voice-hold-button\s*\{([^}]*)\}/s);
  assert.ok(voice, 'capture page must define the hold-to-talk control');
  // 语音按钮已改为与「继续添加」同高：仍是标准 44px 命中高度，
  // 只是不再用更大的 --a-hit-voice（按钮整体缩小是按使用反馈改的）。
  assert.match(voice[1], /min-height:\s*var\(--a-hit\)/, 'voice control keeps the standard 44px hit target');
  // 视觉圆与触控区分离：麦克风要放进 52px 的输入框，44 的圆四周只剩 4px 太挤，
  // 但直接缩小按钮又会让持续手势的落点低于标准触控高度。
  // 所以圆画在 ::before 上，按钮本体保持 44。下面同时锁住「圆更小」这一点。
  const circle = capture.match(/\.voice-hold-button::before\s*\{([^}]*)\}/s);
  assert.ok(circle, 'the visible circle lives on ::before so the hit area can stay 44px');
  const circleSize = Number((circle[1].match(/width:\s*(\d+)px/) || [])[1]);
  const hitSize = Number((voice[1].match(/--a-hit|width:\s*var\(--a-hit\)/) ? 44 : 0));
  assert.ok(circleSize > 0 && circleSize < hitSize,
    `视觉圆（${circleSize}px）必须小于触控区（${hitSize}px），否则就是白改`);
  assert.match(circle[1], /background:\s*var\(--a-accent-wash\)/, 'voice control must not compete with the filled primary CTA');
  assert.match(circle[1], /border:\s*1\.5px\s+solid\s+var\(--a-accent\)/, 'accent outline keeps the secondary voice action discoverable');
  assert.match(capture, /\.voice-hold-button--active::before\s*\{[^}]*background:\s*var\(--a-accent-strong\)/s, 'recording state becomes unmistakable');
  assert.match(capture, /\.voice-hold-button--cancel::before\s*\{[^}]*background:\s*var\(--a-danger\)/s, 'cancelled state becomes unmistakable');
  const primary = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8');
  assert.match(primary, /\.primary-button\s*\{[^}]*background:\s*var\(--a-accent\)/s, 'the primary next-step control retains the solid accent fill');
});

test('capture voice control sits inside the composer and keeps its state feedback', () => {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxss'), 'utf8');
  assert.match(markup, /placeholder="输入现场说明或问题描述"/, 'manual text entry should explain its own purpose without repeating the nearby mic instruction');
  // 文字与语音合成一个对话式输入框：麦克风在框内、文本域之后。
  assert.match(markup, /class="issue-composer"[\s\S]*?issue-draft-card__textarea[\s\S]*?voice-hold-button/,
    'the mic lives inside the composer, to the right of the textarea');
  // 框内放不下文字，所以常驻提示行去掉了；但录音过程中的状态反馈必须留着，
  // 否则「松手完成 / 上滑取消」无从得知。
  assert.doesNotMatch(markup, /松开转字 · 上滑取消/, 'the idle hint line was deliberately removed');
  assert.doesNotMatch(markup, /voice-hold-button__hint/, 'no leftover hint node in the markup');
  assert.match(markup, /voice-hold-status/, 'recording state moves to its own line under the composer');
  assert.match(markup, /正在转成文字…/, 'transcribing state stays visible');
  assert.match(markup, /松开，完成转写/, 'release-to-finish stays visible while recording');
  assert.match(markup, /松开，取消这段/, 'cancel-by-slide stays discoverable while recording');
  // 手势说明仍由无障碍描述承担。
  assert.match(markup, /aria-label="按住说话（记入照片/, 'the gestures remain described for assistive tech');
  // 尺寸：麦克风按钮用标准 44px 命中高度。
  assert.match(style, /\.voice-hold-button\s*\{[^}]*min-height:\s*var\(--a-hit\)/s, 'the mic uses the standard hit height');
});test('AI review distinguishes useful suggestions from an empty result without implying acceptance', () => {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/result/index.wxml'), 'utf8');
  assert.match(markup, /summary\.visionRequested && summary\.aiIssueCount > 0/, 'only photo recognition issues are presented as AI photo analysis');
  assert.match(markup, /summary\.visionRequested && !summary\.aiIssueCount/, 'manual review additions must not hide an empty-AI recovery message');
  assert.match(markup, /summary\.textOrganizationRequested && !summary\.visionRequested && summary\.aiHasOutput/, 'text-only AI work is visibly distinct from photo recognition');
  assert.match(markup, /文字整理结果 · 待核对/);
  assert.match(markup, /AI 识图完成 · 待你核对/);
  assert.match(markup, /\{\{summary\.aiIssueCount\}\} 项待核对问题/,
    'the review entry must show how much AI output was actually returned');
  assert.match(markup, /bindtap="handleAcceptAllAndSubmit"/,
    'review retains its explicit confirmation action');
  assert.match(markup, /AI 未识别到明确问题/, 'empty AI output must not imply the model verified the photo');
  assert.match(markup, /group\.aiEmpty[\s\S]*?未获得识别结果，可手动添加问题。/, 'partial empty results must be visible on their specific photo, not hidden by batch-level counts');
  assert.match(markup, /bindtap="retryAiRecognition"[\s\S]*?重新识图/, 'empty AI review must provide a direct, explicit retry path');
  assert.doesNotMatch(markup, /AI 现场观察|bindtap="acceptObservation"/, 'generic scene observations are not presented or adopted as AI issue output');
});

test('multi-photo AI progress names completed photos and retry targets in the existing progress panel', () => {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxml'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.js'), 'utf8');
  assert.match(markup, /analyzePhotoProgressText/);
  assert.match(source, /已完成照片：\$\{completedPhotoNumbers\}/);
  assert.match(source, /待重试照片：\$\{pendingPhotoNumbers\}/);
});

test('capture primary action names the selected processing step instead of leaving AI recognition implicit', () => {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxml'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.js'), 'utf8');
  assert.match(markup, /bindtap="handleContinueReview">\{\{nextActionLabel\}\}/);
  assert.match(source, /function getNextActionLabel/);
  assert.doesNotMatch(source, /return "开始 AI 识图"/);
  assert.match(source, /return "整理说明并核对"/);
  assert.match(source, /return "进入人工核对"/);
});

test('photo organization exposes direct manual, AI and annotation buttons', () => {
  const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(root, 'miniprogram/pages/inspection/create/index.wxss'), 'utf8');
  const mode = markup.match(/<button class="[^"]*photo-processing-mode[\s\S]*?<\/button>/);
  assert.ok(mode, 'each photo must keep its organization mode selectable');
  assert.match(mode[0], /bindtap="recognizePhoto"/);
  assert.doesNotMatch(markup, /<text>我来说明<\/text>/);
  assert.match(markup, /bindtap="openAnnotate"[\s\S]*?<text>标注/);
  assert.doesNotMatch(markup, /bindlongpress=/);
  assert.doesNotMatch(mode[0], /更改<\/text>/, 'the whole mode control is already actionable, so a second “change” label is redundant');
  assert.match(style, /\.photo-processing-mode\s*\{[^}]*min-height:\s*var\(--a-hit\)[^}]*border:\s*1px solid var\(--a-line\)[^}]*background:\s*var\(--a-surface\)/s, 'the mode choice must read as an interactive control while following the shared visual tokens');
  assert.match(style, /\.photo-processing-mode__chevron\s*\{[^}]*width:\s*var\(--a-icon-sm\)[^}]*height:\s*var\(--a-icon-sm\)/s);
  assert.match(style, /\.photo-processing-mode--ai\s*\{[^}]*border-color:\s*var\(--a-accent\)[^}]*background:\s*var\(--a-accent-wash\)/s);
  assert.doesNotMatch(style, /\.photo-processing-mode__change\s*\{/, 'remove the orphaned visual rule along with the redundant label');
});

test('report exposes saved area and category and defaults sharing management to read-only',()=>{
 const markup=fs.readFileSync(path.join(root,'miniprogram/pages/report/detail/index.wxml'),'utf8');
 const source=fs.readFileSync(path.join(root,'miniprogram/pages/report/detail/index.js'),'utf8');
 assert.match(markup,/wx:if="\{\{issue\.area\}\}"[\s\S]*?<text class="report-field__label">区域<\/text><text>\{\{issue\.area\}\}/);
 assert.match(markup,/wx:if="\{\{issue\.category\}\}"[\s\S]*?<text class="report-field__label">分类<\/text><text>\{\{issue\.category\}\}/);
 assert.match(source,/isOwner: false/);
 assert.match(source,/isOwner: report\.accessMode === "owner"/);
});

test('report photo enlargement has a discoverable, system-sized tap target', () => {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/report/detail/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/report/detail/index.wxss'), 'utf8');
  assert.match(wxml, /class="[^"]*issue-group__zoom"[^>]*catchtap="handlePreviewImage"[^>]*aria-label="查看\{\{group\.groupTitle\}\}大图及对应问题"/, 'the viewer entry must explain both enlargement and its issue context');
  const rule = wxss.match(/\.issue-group__zoom\s*\{([^}]*)\}/s);
  assert.ok(rule, 'report photo must expose a dedicated viewer control');
  assert.match(rule[1], /min-height\s*:\s*var\(--a-hit\)/, 'viewer control must use the shared minimum hit target');
  assert.match(rule[1], /background\s*:\s*var\(--a-paper\)/, 'viewer affordance should use the report paper surface, not introduce another accent block');
  assert.match(rule[1], /font-size\s*:\s*var\(--a-type-caption\)/, 'viewer affordance should stay subordinate to the photo');
});

test('report image viewer gives the photo most of the screen and puts an easy return action at the bottom', () => {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/report/detail/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(root, 'miniprogram/pages/report/detail/index.wxss'), 'utf8');
  assert.match(wxml, /class="[^"]*report-image-viewer__close" bindtap="closeImageViewer">返回报告/);
  assert.doesNotMatch(wxml, /report-image-viewer__head[^\n]*report-image-viewer__close/, 'the primary exit must not be a tiny top-edge control');
  assert.match(wxss, /\.report-image-viewer__stage\s*\{[^}]*flex:\s*1/s, 'the photo stage must consume the remaining screen height');
  const closeRule = wxss.match(/\.report-image-viewer__close\s*\{([^}]*)\}/s);
  assert.ok(closeRule);
  assert.match(closeRule[1], /min-height:\s*var\(--a-hit-primary\)/);
  assert.match(closeRule[1], /width:\s*calc\(100% - 2 \* var\(--a-page-inset\)\)/);
  assert.match(wxss, /\.report-image-viewer__issues\s*\{[^}]*flex:\s*none/s, 'issue details must not compete with the photo for all available height');
});

test('project detail separates the new-record action from explicit draft continuation', () => {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/project/detail/index.wxml'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'miniprogram/pages/project/detail/index.js'), 'utf8');
  const primaryAction = wxml.indexOf('开始现场记录');
  const pendingDrafts = wxml.indexOf('未完成记录');
  assert.ok(primaryAction >= 0 && pendingDrafts > primaryAction, 'the immediate field-record action precedes optional draft and photo content');
  assert.ok(wxml.indexOf('查看全部照片') > pendingDrafts, 'the gallery stays available as a quiet secondary destination');
  assert.doesNotMatch(wxml, /project-feature__media|最近现场照片/, 'project identity page should not duplicate the gallery with a large hero photo');
  assert.match(wxml, /bindtap="continueDraft"/, 'a saved draft must have a clearly separate continuation target');
  assert.match(script, /goInspectionCreate\(\)[\s\S]*?this\.setData\(\{captureChoiceOpen:true\}\)/, 'the primary action must first show the capture-source choice');
  assert.match(wxml, /captureChoiceOpen[\s\S]*data-source-type="camera"[\s\S]*data-source-type="album"/, 'the choice sheet must expose direct camera and album actions');
  assert.match(script, /async chooseCaptureSource[\s\S]*?await choosePhotoFiles\(sourceType\)[\s\S]*?writeDraft\(sessionKey,form,returnContext\)[\s\S]*?this\.navigateToRecord\(sessionKey\)/, 'the native picker and durable project draft must finish before entering the capture page');
  assert.doesNotMatch(script, /captureSource=/, 'new captures must not navigate to a blank page just to open the picker later');
  assert.doesNotMatch(wxml, /继续这次记录|拍摄现场照片/);
});
