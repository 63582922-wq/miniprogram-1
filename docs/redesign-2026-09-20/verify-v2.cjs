const {chromium}=require('playwright');
const assert=require('assert/strict');
const path=require('path');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const page=await browser.newPage({viewport:{width:1440,height:1200}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
 await page.goto('file://'+path.join(__dirname,'visual-master-v2.html'));
 await page.locator('.photo img').first().waitFor();
 assert(await page.locator('.photo img').evaluateAll(imgs=>imgs.length===3&&imgs.every(i=>i.complete&&i.naturalWidth>0)));
 await page.screenshot({path:path.join(__dirname,'master-v2.png'),fullPage:true});
 await page.locator('#screens').screenshot({path:path.join(__dirname,'three-screens-v2.png')});
 await page.locator('[data-mode="flow"]').click();
 await page.locator('[data-action="mark"]').click();assert(await page.locator('.photo').first().evaluate(e=>e.classList.contains('hide-marks')));
 await page.locator('[data-action="mark"]').click();
 await page.locator('#voice').focus();await page.keyboard.down(' ');assert(await page.locator('#voice').evaluate(e=>e.classList.contains('recording')));await page.keyboard.up(' ');
 await page.locator('[data-action="analyze"]').click();assert(await page.locator('[data-screen="1"]').isVisible());
 await page.locator('[data-action="edit1"]').click();await page.locator('#edit-title').fill('测试：已核对的现场描述');await page.locator('#save-edit').click();assert.equal(await page.locator('.report .title-one').textContent(),'测试：已核对的现场描述');
 await page.locator('[data-action="submit"]').click();assert(await page.locator('[data-screen="1"]').isVisible());
 await page.locator('#checked').check();await page.locator('[data-action="submit"]').click();assert(await page.locator('[data-screen="2"]').isVisible());
 await page.locator('[data-action="share"]').click();assert(await page.locator('#modal').isVisible());await page.locator('#close').click();
 await page.reload();await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.locator('[data-screen="0"] .screen').screenshot({path:path.join(__dirname,'capture-v2.png')});
 assert.deepEqual(errors,[]);console.log('PASS: 3 images loaded, annotation, press-and-hold, edit/report sync, confirmation gate, share dialog, 390px width, no script errors.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
