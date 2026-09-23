const { chromium } = require('playwright');
const path = require('path');
const assert = require('assert/strict');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('file://' + path.join(__dirname, 'visual-master.html'));
    assert.equal(await page.locator('.sheet').count(), 6);
    await page.screenshot({ path: path.join(__dirname, 'master-overview.png'), fullPage: true });
    await page.locator('#project-search').fill('无匹配');
    assert(await page.locator('#no-results').isVisible());
    await page.locator('#project-search').fill('');
    await page.locator('[data-screen="0"] [data-go="1"]').first().click();
    assert(await page.locator('[data-screen="1"]').isVisible());
    await page.locator('[data-screen="1"] .primary').click();
    await page.locator('[data-act="annotate"]').click();
    assert(await page.locator('#capture-photo').evaluate(e => e.classList.contains('annotated')));
    await page.locator('[data-act="analyze"]').click();
    await page.locator('[data-act="edit"]').click();
    await page.locator('#edit-title').fill('已核对的现场描述');
    await page.locator('#save-edit').click();
    assert.equal(await page.locator('#report-title').textContent(), '已核对的现场描述');
    await page.locator('[data-act="remove"]').click();
    assert.equal(await page.locator('#report-count').textContent(), '1');
    assert(await page.locator('#report-issue-one').evaluate(e => e.hidden));
    await page.locator('[data-act="remove"]').click();
    await page.locator('[data-act="publish"]').click();
    assert(await page.locator('[data-screen="3"]').isVisible());
    await page.locator('#confirmed').check();
    await page.locator('[data-act="publish"]').click();
    assert(await page.locator('[data-screen="4"]').isVisible());
    await page.locator('[data-screen="4"] [data-go="5"]').click();
    await page.locator('[data-act="share"]').click();
    assert(await page.locator('#modal').isVisible());
    await page.locator('#modal-close').click();
    for (const theme of ['green','ink','blue']) {
      await page.locator('button[data-theme="'+theme+'"]').click();
      assert.equal(await page.locator('body').getAttribute('data-theme'), theme);
    }
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(__dirname, 'master-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.locator('[data-mode="flow"]').click();
    await page.locator('[data-step="2"]').click();
    await page.locator('[data-screen="2"] .viewport').screenshot({ path: path.join(__dirname, 'capture-detail.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: six screens, navigation, annotation toggle, edit propagation, remove/undo, confirmation gate, share dialog, three themes, 390px overflow, no page errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
