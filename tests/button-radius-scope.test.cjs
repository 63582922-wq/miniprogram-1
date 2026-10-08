const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const miniprogram=path.join(root,'miniprogram');

/**
 * 全局 `.ui-button-reset { border-radius: 胶囊 !important }` 是让「按键做成半圆边」
 * 真正生效的唯一办法——小程序原生 button 的默认圆角和各组件样式只有 !important
 * 压得住（项目里有 13 个文件把 precision-a.wxss 的 @import 写在文件中间，
 * 靠级联顺序判定并不可靠）。
 *
 * 代价是：项目里大量「整行可点控件」是借 ui-button-reset 清掉 button 默认样式的，
 * 它们不是按键。如果不声明自己的圆角，就会被钳成体育场形，而 button 默认
 * overflow:hidden 会直接切掉上下两端的文字。
 *
 * 这个 bug 已经犯过三次，所以按结构特征锁死，而不是靠人工记得加：
 * 按键只放 <text>/<image>；含 <view> 的一律视为整行/卡片式布局。
 */

function walkFiles(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** 每个「含 <view> 的 ui-button-reset 元素」返回它的类名数组。 */
function rowLikeControls(wxml) {
  const rows = [];
  for (const m of wxml.matchAll(/<button\b([^>]*?)>([\s\S]*?)<\/button>/g)) {
    const attrs = m[1];
    const inner = m[2];
    if (!/\bui-button-reset\b/.test(attrs)) continue;
    if (!/<view\b/.test(inner)) continue;
    const cls = attrs.match(/class="([^"]*)"/);
    if (!cls) continue;
    const classes = cls[1].split(/\s+/).filter((c) => c && c !== 'ui-button-reset' && !c.includes('{{'));
    if (classes.length) rows.push(classes);
  }
  return rows;
}

const escapeClass = (c) => c.replace(/[-_]/g, (m) => '\\' + m);

/** 该元素是否已被钉成直角（任一类即可）。 */
function pinnedToSquare(joined, classes) {
  return classes.some((c) => {
    const esc = escapeClass(c);
    // 首选写法：.x.x{border-radius:0!important} —— 重复类名把优先级提到 (0,2,0)，
    // 不依赖 @import 的位置顺序。
    if (new RegExp(`\\.${esc}\\.${esc}\\s*\\{[^}]*border-radius\\s*:\\s*0\\s*!important`, 's').test(joined)) {
      return true;
    }
    // 或者它自己声明了非胶囊的 !important 圆角。
    const own = joined.match(new RegExp(`\\.${esc}\\s*\\{[^}]*border-radius\\s*:([^;}]*)`, 's'));
    return Boolean(own) && /!important/.test(own[1]) && !/--a-radius-pill/.test(own[1]);
  });
}

test('every row-like ui-button-reset control opts out of the global pill radius', () => {
  const joined = walkFiles(miniprogram, '.wxss')
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const offenders = [];
  for (const file of walkFiles(miniprogram, '.wxml')) {
    for (const classes of rowLikeControls(fs.readFileSync(file, 'utf8'))) {
      if (!pinnedToSquare(joined, classes)) {
        offenders.push(`${path.relative(root, file)} → .${classes.join(' .')}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `这些整行控件没退出全局胶囊圆角，会被体育场形弧线切掉文字：\n  ${offenders.join('\n  ')}`
  );
});

test('the global pill rule stays !important, otherwise it cannot beat the native button radius', () => {
  const tokens = fs.readFileSync(path.join(miniprogram, 'styles/precision-a.wxss'), 'utf8');
  assert.match(
    tokens,
    /\.ui-button-reset\s*\{[^}]*border-radius\s*:\s*var\(--a-radius-pill\)\s*!important/s,
    'the pill must keep !important to override the native button default and component styles'
  );
});

test('the scope guard actually catches a row that forgot to opt out', () => {
  // 反向验证：如果哪天有人新加一个整行控件却忘了加直角规则，这条守卫必须报出来。
  const joined = fs.readFileSync(path.join(miniprogram, 'styles/precision-a.wxss'), 'utf8');
  const forgot = rowLikeControls(
    '<button class="ui-button-reset brand-new-row" bindtap="go"><view class="brand-new-row__title">标题</view></button>'
  );
  assert.deepEqual(forgot, [['brand-new-row']], 'row-like detection must find the new control');
  assert.equal(
    pinnedToSquare(joined, ['brand-new-row']),
    false,
    'a brand new row has no square pin yet, so the guard would flag it'
  );
});
