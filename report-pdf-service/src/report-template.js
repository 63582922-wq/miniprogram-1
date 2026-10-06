const { sanitizeImageUrl } = require("./url-guard");

const escapeHtml=(v="")=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const text=v=>escapeHtml(v).replace(/\n/g,"<br>");
function groupItemsByImage(items=[],photos=[]){
  const groups=[],map=new Map();
  const registerPhotoAliases = (photo, group, index) => {
    [photo.id, photo.photoId, photo.mediaId, photo.imagePath, photo.annotatedImagePath]
      .filter(value => typeof value === "string" && value)
      .forEach(value => {
        if (!map.has(value)) map.set(value, group);
        else if (map.get(value) !== group) map.set(value, null);
      });
    // Legacy positional aliases are only fallbacks. Never overwrite a real
    // stable photo ID such as "photo-1" with an index alias from another row.
    if (!map.has(`photo-${index}`)) map.set(`photo-${index}`, group);
    if (!map.has(`source-${index}`)) map.set(`source-${index}`, group);
  };
  photos.forEach((p,i)=>{
    const key=[p.id,p.photoId,p.mediaId,p.imagePath,p.annotatedImagePath]
      .find(value => typeof value === "string" && value) || `photo-${i}`;
    const g={key,imageUrl:"",originalImageUrl:p.imagePath||"",annotatedImageUrl:p.annotatedImagePath||"",caption:p.caption||"",items:[],sourceIndex:p.sourceIndex??i};
    groups.push(g);
    registerPhotoAliases(p,g,i);
  });
  items.forEach((item,index)=>{
    const image=(item.annotatedImages||[])[0]||(item.images||[])[0]||"";
    // IDs are authoritative for v2. Legacy preserves historical image grouping and order.
    const key=item.sourcePhotoId||image||"legacy-"+(item.sourceIndex??index);
    const hasAlias=map.has(key);
    const matched=hasAlias?map.get(key):undefined;
    if(matched===null){
      // Repeated legacy paths cannot prove which photo owns this item. Keep a
      // separate group so the PDF remains honest instead of cross-linking it.
      const g={key:`legacy-unresolved-${index}`,imageUrl:image,items:[],sourceIndex:item.sourceIndex??index,sourceAmbiguous:true};
      groups.push(g);g.items.push(item);return;
    }
    if(!matched){const g={key,imageUrl:image,items:[],sourceIndex:item.sourceIndex??index,sourceAmbiguous:true};groups.push(g);map.set(key,g);}
    (map.get(key)||groups[groups.length-1]).items.push(item);
  });
  if(photos.length)groups.sort((a,b)=>(a.sourceIndex??0)-(b.sourceIndex??0));
  groups.forEach(g=>{
    g.items.sort((left,right)=>(left.markerNumber||left.subIssueIndex||0)-(right.markerNumber||right.subIssueIndex||0));
    g.mappingText=g.items.length&&g.items.every(item=>Number(item.markerNumber)>0)
      ?"照片标注号与下方同号问题一一对应"
      :"问题按本照片内顺序编号；未标注位置的问题没有照片编号";
    g.imageUrl=g.items.length?(g.annotatedImageUrl||g.imageUrl||g.originalImageUrl):(g.originalImageUrl||g.imageUrl||g.annotatedImageUrl);
  });
  return groups;
}
function checkedImage(value){
  const safe=sanitizeImageUrl(value);
  if(value&&!safe)throw new Error("报告照片来源不可用，请检查云存储地址后重试");
  return escapeHtml(safe);
}
function buildStats(report={}){
  const items=Array.isArray(report.items)?report.items:[];
  const counts={critical:0,major:0,normal:0};
  items.forEach(item=>{const key=["critical","major","normal"].includes(item&&item.severity)?item.severity:"normal";counts[key]+=1;});
  return {photos:Array.isArray(report.photos)?report.photos.length:0,issues:items.length,...counts};
}
function renderGroup(g,index){
  const image=checkedImage(g.imageUrl);
  const title=`照片 ${String(index+1).padStart(2,'0')}`;
  const count=g.items.length?`${g.items.length} 项问题`:"未记录问题";
  const sourceNote=g.sourceAmbiguous?'<span class="source-note">来源待确认</span>':'';
  return `<section class="photo-group ${index===0?'photo-group--first':''}">
    <div class="group-head">
      <div><div class="group-kicker">${String(index+1).padStart(2,'0')} / ${g.items.length?'问题':'现场记录'}</div><h2>${title}</h2></div>
      <div class="group-status">${count}${sourceNote}</div>
    </div>
    <figure class="photo-figure">
      ${image?`<div class="photo-frame"><img class="photo" src="${image}" alt="现场照片"></div>`:'<p class="muted photo-missing">旧记录未保留照片来源</p>'}
      ${g.caption?`<figcaption class="photo-caption">现场说明　${text(g.caption)}</figcaption>`:""}
    </figure>
    ${g.items.length?`<div class="issue-list"><div class="mapping-note">${escapeHtml(g.mappingText)}</div>${g.items.map((i,n)=>`<article class="issue ${(i.description||'').length+(i.suggestion||'').length<500?'issue--short':''}">
      <div class="issue-no">${i.markerNumber||i.subIssueIndex||n+1}.</div><div class="issue-body">
        <div class="issue-kicker">现场问题</div>
        <h3>${text(i.description)}</h3>
        <div class="issue-marker">${i.markerNumber ? `照片标注 ${escapeHtml(i.markerNumber)}` : "未标注位置"}</div>
        <p class="meta">${[i.severityText,i.responsiblePartyText,i.area,i.category].filter(Boolean).map(escapeHtml).join("　/　")}</p>
        ${i.suggestion?`<p class="suggestion"><span>处理建议</span>${text(i.suggestion)}</p>`:""}
      </div>
    </article>`).join("")}</div>`:'<p class="muted zero-note">本组未记录问题，照片保留为现场记录。未记录问题不代表工程验收合格。</p>'}
  </section>`;
}
function buildReportHtml(report={}){
  const groups=groupItemsByImage(report.items||[],report.photos||[]);
  const logo=checkedImage(report.logoUrl);
  const stats=buildStats(report);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(report.title||"现场巡查报告")}</title>
  <style>
  @page{size:A4;margin:14mm 15mm 17mm}
  :root{--paper:#F4F0EA;--ink:#20201E;--muted:#77736C;--line:#D1C9BF;--line-strong:#AFA69B;--surface:#E8E1D8;--accent:#D9673B;--accent-soft:#F0D8CB}
  *{box-sizing:border-box}html,body{background:var(--paper)}body{margin:0;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-size:10.5pt;line-height:1.62;overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  p{margin:7px 0;orphans:3;widows:3}h1,h2,h3{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;font-weight:400;margin:0}
  .header{padding:0 0 18px;margin-bottom:20px;border-top:1.5px solid var(--accent);border-bottom:1px solid var(--line)}
  .masthead{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:16px 0 18px;border-bottom:1px solid var(--line)}
  .org{display:flex;align-items:center;gap:11px;min-width:0}.logo{width:45px;height:45px;object-fit:contain;flex:none}.org-name{font-size:11pt;line-height:1.35;letter-spacing:.02em}.org-kind{margin-top:2px;color:var(--muted);font-size:8pt;letter-spacing:.08em}.doc-mark{text-align:right;white-space:nowrap}.doc-mark__type{font-size:11pt;letter-spacing:.12em}.doc-mark__en{margin-top:3px;color:var(--muted);font-size:7.5pt;letter-spacing:.16em}
  .title-block{padding:22px 0 17px}.kicker,.group-kicker,.section-kicker{font-size:8pt;color:var(--accent);letter-spacing:.14em;line-height:1.35}.title-block h1{margin-top:8px;font-size:25pt;line-height:1.22;letter-spacing:-.4px}.title-block .meta{margin-top:9px}.meta,.company{font-size:8.8pt;color:var(--muted);line-height:1.65}.company{margin-top:10px}
  .document-meta{display:grid;grid-template-columns:1.35fr 1fr;gap:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.document-meta__item{min-height:43px;padding:9px 12px 9px 0;border-right:1px solid var(--line)}.document-meta__item:nth-child(2n){padding-left:14px;border-right:0}.document-meta__item:nth-child(n+3){border-top:1px solid var(--line)}.document-meta__label{display:block;color:var(--muted);font-size:7.8pt;letter-spacing:.04em}.document-meta__value{display:block;margin-top:2px;font-size:9.7pt;line-height:1.45;word-break:break-word}.contact-line{padding-top:9px;color:var(--muted);font-size:8.8pt}
  .summary{margin:22px 0 25px;padding:0 0 17px;border-bottom:1px solid var(--line)}.summary-label{display:block;margin-bottom:9px;font-size:8pt;color:var(--muted);letter-spacing:.12em}.summary-conclusion{font-size:13pt;line-height:1.55}.scope{font-size:8.8pt;color:var(--muted);margin-top:11px}.summary-stats{display:grid;grid-template-columns:1.15fr 1.15fr repeat(3,1fr);margin-top:15px;padding-top:12px;border-top:1px solid var(--line);font-size:8.2pt;color:var(--muted)}.summary-stats span{display:flex;align-items:baseline;gap:4px;white-space:nowrap;border-left:1px solid var(--line);padding-left:9px}.summary-stats span:first-child{border-left:0;padding-left:0}.summary-stats b{color:var(--ink);font-size:13pt;font-weight:400;line-height:1}
  .section-lead{margin:0 0 10px}.section-lead__title{font-size:17pt;line-height:1.35}.section-lead__meta{margin-top:3px;color:var(--muted);font-size:8.5pt}
  .photo-group{break-inside:auto;margin-top:22px}.photo-group+.photo-group{margin-top:28px}.group-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;padding:0 0 8px;border-bottom:1px solid var(--line-strong);break-after:avoid}.group-head h2{margin-top:3px;font-size:17pt;line-height:1.25;letter-spacing:-.2px}.group-status{max-width:42%;padding-bottom:2px;color:var(--muted);font-size:8.5pt;line-height:1.4;text-align:right}.source-note{display:block;color:var(--accent);font-size:7.5pt;margin-top:2px}.photo-figure{margin:13px 0 0;break-inside:avoid}.photo-frame{display:flex;align-items:center;justify-content:center;min-height:42mm;max-height:68mm;overflow:hidden;background:var(--surface)}.photo{width:100%;height:auto;max-height:68mm;object-fit:contain;display:block}.photo-group--first .photo-frame,.photo-group--first .photo{max-height:70mm}.photo-caption{padding-top:7px;color:var(--muted);font-size:8.7pt;line-height:1.55}.photo-missing{padding:22px 0;color:var(--muted);font-size:9pt}
  .issue-list{margin-top:13px}.mapping-note{margin-bottom:5px;color:var(--muted);font-size:8pt}.issue{display:grid;grid-template-columns:24px minmax(0,1fr);gap:9px;padding:11px 0 12px;border-top:1px solid var(--line);break-inside:avoid}.issue-no{font-size:12pt;line-height:1.55;color:var(--accent);font-variant-numeric:tabular-nums}.issue-body{min-width:0}.issue-kicker{margin-bottom:3px;color:var(--muted);font-size:7.8pt;letter-spacing:.06em}.issue-marker{margin-top:3px;color:var(--muted);font-size:8pt}.issue h3{font-size:10.8pt;line-height:1.6;orphans:3;widows:3}.issue .meta{margin-top:5px;font-size:8.3pt}.suggestion{margin-top:7px;font-size:9.5pt;line-height:1.58}.suggestion span{color:var(--muted);margin-right:7px}.muted{color:var(--muted);font-size:9pt}.zero-note{padding:13px 0;border-top:1px solid var(--line);line-height:1.55}
  .report-footer{margin-top:28px;padding-top:13px;border-top:1px solid var(--line-strong);display:flex;justify-content:space-between;gap:18px;color:var(--muted);font-size:8pt;line-height:1.5}.report-footer__right{text-align:right}.test-label{font-size:8.5pt;padding:8px 10px;border:1px solid var(--accent);color:#A94B32;margin-bottom:12px}
  </style></head><body>
    ${report.testLabel?`<div class="test-label">${escapeHtml(report.testLabel)}</div>`:""}
    <header class="header">
      <div class="masthead"><div class="org">${logo?`<img class="logo" src="${logo}" alt="单位标识">`:""}<div><div class="org-name">${escapeHtml(report.companyName||"个人巡查")}</div><div class="org-kind">巡查单位</div></div></div><div class="doc-mark"><div class="doc-mark__type">现场巡查报告</div><div class="doc-mark__en">FIELD REPORT</div></div></div>
      <div class="title-block"><div class="kicker">尺包 · 报告交付文档</div><h1>${escapeHtml(report.projectName||report.title||"现场巡查报告")}</h1><div class="meta">${escapeHtml(report.title||"现场巡查报告")}　/　${escapeHtml(report.inspectionDateText||report.inspectionDate||"")}</div></div>
      <div class="document-meta">
        <div class="document-meta__item"><span class="document-meta__label">报告编号</span><span class="document-meta__value">${escapeHtml(report.reportNo||"待生成")}</span></div>
        <div class="document-meta__item"><span class="document-meta__label">巡查人</span><span class="document-meta__value">${escapeHtml(report.inspectorName||"未填写")}${report.inspectorPhone?`　${escapeHtml(report.inspectorPhone)}`:""}</span></div>
        <div class="document-meta__item"><span class="document-meta__label">项目位置</span><span class="document-meta__value">${escapeHtml(report.projectAddress||"未填写")}</span></div>
        <div class="document-meta__item"><span class="document-meta__label">巡查单位</span><span class="document-meta__value">${escapeHtml(report.companyName||"个人巡查")}</span></div>
      </div>
      <div class="contact-line">联系电话　${escapeHtml(report.companyPhone||report.inspectorPhone||report.publisherPhone||"未填写")}</div>
    </header>
    <section class="summary"><span class="summary-label">01 / 巡查概览</span><div class="summary-conclusion">${text(report.summary||"本次记录仅覆盖所拍照片与现场说明。")}</div><div class="summary-stats"><span><b>${stats.photos}</b>张照片</span><span><b>${stats.issues}</b>项问题</span><span>严重 <b>${stats.critical}</b></span><span>较重 <b>${stats.major}</b></span><span>一般 <b>${stats.normal}</b></span></div>
    ${report.contextNote?`<p class="scope">现场补充　${text(report.contextNote)}</p>`:""}<p class="scope">内容经记录人核对。未记录问题不代表工程验收合格；照片标注仅用于指出现场位置，不用于测量实物尺寸。</p></section>
    <div class="section-lead"><div class="section-kicker">02 / 现场内容</div><div class="section-lead__title">照片与问题</div><div class="section-lead__meta">按照片顺序记录，同一照片内的问题保持原编号。</div></div>
    ${groups.map(renderGroup).join("")||'<p class="muted">旧记录无可用照片分组，请以已保存的文字为准。</p>'}
    <footer class="report-footer"><div>尺包 · 现场记录与报告</div><div class="report-footer__right">${escapeHtml(report.companyName||"个人巡查")}<br>${escapeHtml(report.reportNo||"待生成")}</div></footer>
  </body></html>`;
}
module.exports={buildReportHtml,groupItemsByImage};
