const { chromium } = require('playwright');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 960 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(`file://${path.resolve(__dirname, '../docs/redesign-2026-09-20/convergence-master.html')}`);

    const visualContract = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const project = getComputedStyle(document.querySelector('.project-card'));
      const title = getComputedStyle(document.querySelector('.page-title'));
      return {
        paper: root.getPropertyValue('--paper').trim(),
        ink: root.getPropertyValue('--ink').trim(),
        orange: root.getPropertyValue('--orange').trim(),
        projectBackground: project.backgroundColor,
        projectRadius: project.borderRadius,
        titleFamily: title.fontFamily,
        titleWeight: title.fontWeight,
      };
    });
    assert.equal(visualContract.paper, '#E9E4DD');
    assert.equal(visualContract.ink, '#191816');
    assert.equal(visualContract.orange, '#DE6E3F');
    assert.equal(visualContract.projectBackground, 'rgba(0, 0, 0, 0)');
    assert.equal(visualContract.projectRadius, '0px');
    assert.match(visualContract.titleFamily, /system-ui|PingFang SC|Noto Sans/);
    assert.equal(visualContract.titleWeight, '600');

    await page.locator('.project-card').click();
    assert.equal(await page.locator('.page-title').textContent(), '示例项目');
    const objectTitle = await page.locator('.page-title').evaluate((node) => getComputedStyle(node).fontFamily);
    assert.match(objectTitle, /Songti SC|STSongti|STSong|Source Han Serif|Noto Serif|SimSun/);
    await page.locator('#footer button').click();
    await page.evaluate(() => {
      photo = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="8" height="8"%3E%3Crect width="8" height="8" fill="%23E2DCD3"/%3E%3C/svg%3E';
      render();
    });
    await page.locator('textarea').fill('隔离示例说明');
    await page.locator('.evidence').click();
    await page.getByRole('button', { name: '矩形', exact: true }).click();
    const selectedTool = await page.locator('.tool.is-selected').evaluate((node) => {
      const style = getComputedStyle(node);
      return { color: style.color, background: style.backgroundColor };
    });
    assert.equal(selectedTool.background, 'rgba(0, 0, 0, 0)');
    assert.equal(selectedTool.color, 'rgb(183, 79, 45)');
    await page.locator('#footer button').click();
    await page.locator('#footer button').click();
    await page.locator('#footer button').click();
    assert((await page.locator('#screen').textContent()).includes('隔离示例说明'));
    assert((await page.locator('#screen').textContent()).includes('个人出具'));

    await page.locator('#back').click();
    await page.locator('#tabs button').filter({ hasText: '我的' }).click();
    await page.locator('#screen button').filter({ hasText: '巡查人资料' }).click();
    await page.locator('#company').fill('示例公司');
    await page.locator('#inspector').fill('示例巡查人');
    await page.locator('#phone').fill('010-00000000');
    await page.locator('#footer button').click();
    assert((await page.locator('#screen').textContent()).includes('示例公司'));
    await page.screenshot({ path: path.resolve(__dirname, '../docs/redesign-2026-09-20/convergence-profile.png') });

    for (const width of [320, 375, 430]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    await page.locator('#tabs button').first().click();
    await page.screenshot({ path: path.resolve(__dirname, '../docs/redesign-2026-09-20/convergence-project-mobile.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: converged prototype flow, visual tokens, typography, selection state, three widths, no page errors. Not native acceptance.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
