const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('all root pages name their screen in the fixed theme bar', () => {
  for (const [file,title] of [['project/list','全部项目'],['report/list','全部报告'],['profile','我的']]) {
    assert.ok(read(`miniprogram/pages/${file}/index.wxml`).includes(`<product-identity title="${title}"`));
  }
  const project=read('miniprogram/pages/project/list/index.wxml');
  assert.equal((project.match(/bindtap="goCreate"/g)||[]).length,1);
  assert.doesNotMatch(project,/actionText="创建第一个项目"/);
  assert.doesNotMatch(read('miniprogram/custom-tab-bar/index.wxml'),/custom-tab-bar__indicator/);
});

test('report filter hides bottom tabs while open and restores them when closed', () => {
  const script=read('miniprogram/pages/report/list/index.js');
  assert.match(script,/filterVisible:true[^\n]*setFilterTabBarHidden\(true\)/);
  assert.match(script,/closeFilter\(\)\{[^}]*filterVisible:false\}\);this.setFilterTabBarHidden\(false\)/);
  assert.match(read('miniprogram/custom-tab-bar/index.wxml'),/wx:if="\{\{!hiddenByOverlay\}\}"/);
  assert.match(read('miniprogram/pages/report/list/index.wxss'),/filter-sheet__title\{text-align:center/);
});

test('shared back control uses body text, a full-size icon and a larger touch target', () => {
  const styles = read('miniprogram/components/page-nav-bar/index.wxss');
  assert.match(styles, /\.page-nav-bar__back\{[^}]*min-width:calc\(var\(--a-hit\) \* 2\)[^}]*min-height:var\(--a-hit-compact\)[^}]*font-size:var\(--a-type-body\)/);
  assert.match(styles, /\.page-nav-bar__icon\{width:var\(--a-icon\);height:var\(--a-icon\)/);
  assert.match(read('miniprogram/components/page-nav-bar/index.wxml'), /bindtap="handleBackTap" hover-class="is-pressed" aria-label="返回上一页"/);
});

test('creating and editing projects always expose optional fields without a collapse button', () => {
  const markup = read('miniprogram/pages/project/form/index.wxml');
  assert.doesNotMatch(markup, /toggleOptional|showOptional|form-expand/);
  assert.match(markup, /<view class="form-optional">/);
  for (const field of ['clientName', 'clientPhone', 'description']) {
    assert.ok(markup.includes(`data-field="${field}"`));
  }
});

test('bottom navigation centers its contents with equal padding and one downward offset', () => {
  const styles = read('miniprogram/custom-tab-bar/index.wxss');
  assert.match(styles, /padding: calc\(var\(--a-space-1\) \/ 2\) 0 !important/);
  assert.match(styles, /\.custom-tab-bar__icon,\s*\.custom-tab-bar__label\s*\{\s*transform: translateY\(calc\(var\(--a-space-1\) \/ 2\)\)/);
  assert.doesNotMatch(styles, /translateY\(-1rpx\)/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /min-height: var\(--a-hit-tab\)/);
});

test('page titles center independently of back buttons with symmetric capsule clearance', () => {
  const markup = read('miniprogram/components/page-nav-bar/index.wxml');
  const styles = read('miniprogram/components/page-nav-bar/index.wxss');
  assert.match(markup, /left:\{\{capsuleSafeWidth\}\}px;right:\{\{capsuleSafeWidth\}\}px/);
  assert.match(styles, /\.page-nav-bar__heading\{[^}]*position:absolute[^}]*justify-content:center/);
  assert.match(markup, /bindtap="handleBackTap"/);
  assert.match(read('miniprogram/pages/project/detail/index.wxml'), /title="项目详情"/);
});

test('peer labels and actions share typography, line height and vertical alignment', () => {
  const styles = read('miniprogram/app.wxss');
  assert.match(styles, /\.page \.ui-section-row__label,\.page \.ui-section-row__action\{[^}]*align-items:center[^}]*font-size:var\(--a-type-body\)[^}]*line-height:1\.35/);
  const project = read('miniprogram/pages/project/detail/index.wxml');
  assert.match(project, /ui-section-row__label">当前项目/);
  assert.match(project, /ui-section-row__action" bindtap="goEdit">编辑资料/);
  assert.match(read('miniprogram/pages/inspection/create/index.wxml'), /ui-section-row__action" bindtap="chooseAllPhotoProcessing"/);
});
