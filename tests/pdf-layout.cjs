// Offline visual acceptance. Cloud images are fulfilled from a clearly labelled
// design fixture; no customer data, provider calls, or live service are used.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
// Use the renderer shipped with the PDF service itself. Keeping the acceptance
// test on the production engine avoids a false block when the repository root
// does not have a separate Playwright install.
const puppeteer=require('../report-pdf-service/node_modules/puppeteer');
const {buildReportHtml,groupItemsByImage}=require('../report-pdf-service/src/report-template');
const root=path.resolve(__dirname,'..'),out=path.join(root,'output/pdf');
async function main(){
 fs.mkdirSync(out,{recursive:true});
 const photo='https://offline-fixture.tcb.qcloud.la/site.png';
 const markedPhoto='https://offline-fixture.tcb.qcloud.la/site-marked.png';
 const report={title:'现场巡查报告',reportNo:'CB-20260921-PDF1',projectName:'隔离测试项目',inspectionDateText:'2026-09-21',inspectorName:'测试记录人',companyName:'毫厘智管 · 版式测试',testLabel:'隔离测试样本 · 图片为设计演示素材，不是真实现场记录',summary:'校验同图多问题、零问题照片与长文字自然分页。',
   photos:[{id:'photo-1',imagePath:photo,annotatedImagePath:markedPhoto},{id:'photo-2',imagePath:photo,annotatedImagePath:markedPhoto},{id:'photo-3',imagePath:photo}],
   items:[{sourcePhotoId:'photo-1',description:'1号记录：窗框与墙体接缝处需复核。',suggestion:'请结合现场检查确认原因。',severityText:'一般',responsiblePartyText:'待确认'},
     {sourcePhotoId:'photo-1',description:'同图第2项：收口细节需要补充说明。',severityText:'一般'},
     {sourcePhotoId:'photo-3',description:'长文开始。'+('这是一段用于检验打印分页的现场文字，不代表真实缺陷结论。'.repeat(80))+'长文结束。',suggestion:'分页后须保持完整，不裁切。'}]};
 const grouped=groupItemsByImage(report.items,report.photos);assert.equal(grouped.length,3);assert.equal(grouped[1].items.length,0);assert.equal(grouped[0].items.length,2);
 assert.equal(grouped[0].imageUrl,markedPhoto);
 assert.equal(grouped[1].imageUrl,photo,'zero-issue PDF group must prefer the original photo over unexplained marks');
 const browser=await puppeteer.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 try{const page=await browser.newPage();await page.setViewport({width:794,height:1123});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setRequestInterception(true);page.on('request',request=>[photo,markedPhoto].includes(request.url())
     ?request.respond({status:200,contentType:'image/png',body:fs.readFileSync(path.join(root,'docs/redesign-2026-09-20/site-detail.png'))})
     :request.abort());
   await page.setContent(buildReportHtml(report),{waitUntil:'networkidle0'});await page.emulateMediaType('print');
   assert.match(await page.$eval('.document-meta',node=>node.textContent),/CB-20260921-PDF1/);
   assert.match(await page.$eval('.summary-stats',node=>node.textContent),/3张照片/);
   assert.equal(await page.$$eval('.photo',nodes=>nodes.length),3);assert.match(await page.$$eval('h2',nodes=>nodes[1].textContent),/^照片 02$/);
   assert.equal(await page.evaluate(()=>Array.from(document.images).filter(i=>!i.naturalWidth).length),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>794),false);assert.deepEqual(errors,[]);
   await page.pdf({path:path.join(out,'precision-A-isolated-sample.pdf'),format:'A4',printBackground:true,preferCSSPageSize:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="font-size:9px;text-align:right;width:100%;padding:0 14mm;color:#706D67"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',margin:{top:'14mm',bottom:'18mm',left:'14mm',right:'14mm'}});
   console.log('Offline PDF: photos=3, issue groups=3, zero-issue group retained, long text included; no external requests.');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
