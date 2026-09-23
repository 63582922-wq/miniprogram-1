const { sanitizeImageUrl } = require("./url-guard");

const escapeHtml=(v="")=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const text=v=>escapeHtml(v).replace(/\n/g,"<br>");
function chinese(n){const d=["零","一","二","三","四","五","六","七","八","九"];if(n<10)return d[n];if(n===10)return "十";if(n<20)return "十"+d[n-10];return d[Math.floor(n/10)]+"十"+(n%10?d[n%10]:"");}
function groupItemsByImage(items=[],photos=[]){
  const groups=[],map=new Map();
  photos.forEach((p,i)=>{const g={key:p.id,imageUrl:"",originalImageUrl:p.imagePath||"",annotatedImageUrl:p.annotatedImagePath||"",caption:p.caption||"",items:[],sourceIndex:i};groups.push(g);map.set(p.id,g);});
  items.forEach((item,index)=>{
    const image=(item.annotatedImages||[])[0]||(item.images||[])[0]||"";
    // IDs are authoritative for v2. Legacy preserves historical image grouping and order.
    const key=item.sourcePhotoId||image||"legacy-"+(item.sourceIndex??index);
    if(!map.has(key)){const g={key,imageUrl:image,items:[],sourceIndex:item.sourceIndex??index};groups.push(g);map.set(key,g);}
    map.get(key).items.push(item);
  });
  groups.forEach(g=>{g.imageUrl=g.items.length?(g.annotatedImageUrl||g.imageUrl||g.originalImageUrl):(g.originalImageUrl||g.imageUrl||g.annotatedImageUrl);});
  return groups;
}
function checkedImage(value){
  const safe=sanitizeImageUrl(value);
  if(value&&!safe)throw new Error("报告照片来源不可用，请检查云存储地址后重试");
  return escapeHtml(safe);
}
function renderGroup(g,index){
  const image=checkedImage(g.imageUrl);
  const title=(g.items.length?"问题 ":"现场照片 ")+chinese(index+1);
  const count=g.items.length?`${g.items.length} 项问题`:"未记录问题";
  return `<section class="photo-group ${index===0?'photo-group--first':''}"><figure>
    <h2>${title}<span>${count}</span></h2>
    ${image?`<img class="photo" src="${image}" alt="现场照片">`:'<p class="muted">旧记录未保留照片来源</p>'}
    </figure>${g.caption?`<p class="muted">现场说明：${text(g.caption)}</p>`:""}
    ${g.items.length?g.items.map((i,n)=>`<article class="issue ${(i.description||'').length+(i.suggestion||'').length<500?'issue--short':''}">
      <h3><span class="number">${i.subIssueIndex||n+1}.</span> ${text(i.description)}</h3>
      <p class="meta">${[i.severityText,i.responsiblePartyText,i.area,i.category].filter(Boolean).map(escapeHtml).join(" / ")}</p>
      ${i.suggestion?`<p class="suggestion"><strong>建议</strong> ${text(i.suggestion)}</p>`:""}
    </article>`).join(""):'<p class="muted zero-note">本组未记录问题，照片保留为现场记录。未记录问题不代表工程验收合格。</p>'}
  </section>`;
}
function buildReportHtml(report={}){
  const groups=groupItemsByImage(report.items||[],report.photos||[]);
  const logo=checkedImage(report.logoUrl);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(report.title||"现场巡查报告")}</title>
  <style>
  @page{size:A4;margin:14mm 14mm 18mm}
  :root{--paper:#E9E4DD;--ink:#191816;--muted:#706D67;--line:#C9C1B7;--surface:#E2DCD3;--accent:#DE6E3F}
  *{box-sizing:border-box}html,body{background:var(--paper)}body{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.7;overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .header{border-top:5px solid var(--accent);border-bottom:1px solid var(--line);padding:18px 0;margin-bottom:18px}.kicker{font-size:9pt;color:var(--muted);letter-spacing:2px;font-weight:500}
  h1,h2{font-family:"Songti SC","STSong","Source Han Serif SC","Noto Serif CJK SC","SimSun",serif;font-weight:500}h1{margin:8px 0 12px;font-size:26pt;line-height:1.25;letter-spacing:-.5px}p{margin:8px 0;orphans:3;widows:3}
  .meta,.company{font-size:9pt;color:var(--muted);line-height:1.7}.company{margin-top:8px}.logo{float:right;width:60px;height:60px;object-fit:contain;margin-left:20px}
  .summary{margin:20px 0 26px;padding:0 0 16px;border-bottom:1px solid var(--line)}.summary strong{font-size:10pt}.scope{font-size:9pt;color:var(--muted);margin-top:12px}
  figure{margin:0;break-inside:avoid}h2{display:flex;justify-content:space-between;align-items:baseline;margin:0 0 12px;font-size:18pt;line-height:1.5;border-bottom:2px solid var(--ink);padding-bottom:10px}h2 span{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC",sans-serif;font-size:9pt;font-weight:400;color:var(--muted)}
  .photo-group{break-inside:auto}.photo-group+.photo-group{margin-top:28px}.photo{width:100%;height:auto;max-height:90mm;object-fit:contain;display:block;background:var(--surface)}.photo-group--first .photo{max-height:75mm}.issue--short{break-inside:avoid!important}
  .issue{padding:14px 0;border-bottom:1px solid var(--line);break-inside:auto}h3{font-size:12pt;line-height:1.75;margin:0;font-weight:400;orphans:3;widows:3}.number{font-weight:600}
  .suggestion{font-size:11pt;margin-top:8px}.suggestion strong{font-weight:600}.muted{color:var(--muted);font-size:10pt}.zero-note{padding:14px 0}
  .test-label{font-size:10pt;padding:10px;border:1px solid var(--accent);color:#A93E2E;margin-bottom:12px}
  </style></head><body>
    ${report.testLabel?`<div class="test-label">${escapeHtml(report.testLabel)}</div>`:""}
    <header class="header">${logo?`<img class="logo" src="${logo}" alt="单位标识">`:""}<div class="kicker">毫厘智管 / FIELD NOTES</div><h1>${escapeHtml(report.title||"现场记录报告")}</h1>
    <div class="meta">${escapeHtml(report.projectName)} / ${escapeHtml(report.inspectionDateText||report.inspectionDate||"")} / 巡查人 ${escapeHtml(report.inspectorName||"未填写")} ${escapeHtml(report.inspectorPhone||"")}</div>
    ${report.publisherName?`<div class="meta">报告出具人 ${escapeHtml(report.publisherName)} ${escapeHtml(report.publisherPhone||"")}</div>`:""}
    <div class="company">出具方 ${escapeHtml(report.companyName||"个人出具")}${report.companyPhone?` / ${escapeHtml(report.companyPhone)}`:""}${report.companyAddress?`<br>${escapeHtml(report.companyAddress)}`:""}</div></header>
    <section class="summary"><strong>巡查小结</strong><p>${text(report.summary||"本次记录仅覆盖所拍照片与现场说明。")}</p>
    ${report.contextNote?`<strong>现场补充</strong><p>${text(report.contextNote)}</p>`:""}
    <p class="scope">内容经记录人核对。未记录问题不代表工程验收合格；照片标注仅用于指出现场位置，不用于测量实物尺寸。</p></section>
    ${groups.map(renderGroup).join("")||'<p class="muted">旧记录无可用照片分组，请以已保存的文字为准。</p>'}
  </body></html>`;
}
module.exports={buildReportHtml,groupItemsByImage};
