/* Refinements on the approved scope, plus the editable annotation workspace. */
document.title='毫厘智管 · 视觉与精准标注 / 母版03';
document.querySelector('.edition').textContent='VISUAL & INTERACTION / 03';
document.querySelector('.intro h1').textContent='清楚记录，精准落笔。';
document.querySelector('.intro p').textContent='原有巡查链路 · 统一图标与组件 · 可编辑的全屏照片标注';
document.querySelector('.design-note').innerHTML='暖白 / 墨绿灰 / 朱砂标注<br>文字、图标、控件与反馈采用同一套规则<br>可操作母版 · 非正式小程序';
const icon=(name)=>`<i data-lucide="${name}" aria-hidden="true"></i>`;
document.querySelectorAll('.primary .arrow').forEach(e=>e.innerHTML=icon(e.textContent.includes('↗')?'share-2':'arrow-right'));
document.querySelectorAll('.back').forEach(e=>e.innerHTML=icon('chevron-left')+e.querySelector('span').outerHTML);
document.querySelector('[data-action="mark"]').innerHTML=icon('scan-line')+'精准标注';
document.querySelector('[data-action="photo"]').innerHTML=icon('image-plus')+'添加照片';
document.querySelector('[data-action="project"]').innerHTML='更换项目'+icon('chevron-down');
document.querySelectorAll('.edit[data-action]').forEach(e=>e.innerHTML=icon('pencil')+'编辑');
document.querySelector('#voice svg').outerHTML=icon('mic');
document.querySelectorAll('[data-action="pdf"]').forEach(e=>e.innerHTML=icon('file-down')+'PDF 归档');
document.querySelector('.footerhint').textContent='照片与现场说明一并整理';
document.querySelector('.report .micro').textContent='本次记录仅覆盖所拍照片与现场说明。图片及文字为示例，非质量鉴定。';
document.querySelector('.end a').href='设计与标注验收-v3.md';
const editorDialog=document.createElement('dialog');editorDialog.className='annotation-dialog';editorDialog.innerHTML='<iframe title="全屏精准标注" src="about:blank"></iframe><button class="exit-editor">返回，保留草稿</button>';document.body.append(editorDialog);
const frame=editorDialog.querySelector('iframe');let originalSource=new URL('site-detail.png',location.href).href,sourceKey='site-detail.png',savedAnnotations=null,frameInitialized=false;
// Matching editable versions of the two illustrative marks, only if there is no saved draft.
try{const cached=JSON.parse(localStorage.getItem('haoli-annotation-v3')||'null');if(cached?.imageKey===sourceKey)savedAnnotations=cached.shapes}catch(e){}
if(!savedAnnotations)savedAnnotations=[{id:'example-seal',type:'ellipse',a:{x:.49,y:.26},b:{x:.56,y:.74},label:1},{id:'example-plaster',type:'ellipse',a:{x:.61,y:.77},b:{x:.79,y:.92},label:2}];
function openAnnotation(){editorDialog.showModal();if(!frameInitialized){frame.src='annotation-lab.html';frameInitialized=true;frame.onload=()=>setTimeout(()=>frame.contentWindow.postMessage({type:'haoli-annotation-load',src:originalSource,imageKey:sourceKey,shapes:savedAnnotations},location.origin==='null'?'*':location.origin),100)}else frame.contentWindow.postMessage({type:'haoli-annotation-load',src:originalSource,imageKey:sourceKey,shapes:savedAnnotations},location.origin==='null'?'*':location.origin)}
editorDialog.querySelector('.exit-editor').onclick=()=>{try{savedAnnotations=frame.contentWindow.annotationDiagnostics.getSnapshot().shapes}catch(e){}editorDialog.close()};
editorDialog.addEventListener('cancel',()=>{try{savedAnnotations=frame.contentWindow.annotationDiagnostics.getSnapshot().shapes}catch(e){}});
// Capture intercepts V2's illustration-only mark action.
document.addEventListener('click',e=>{if(e.target.closest('[data-action="mark"]')){e.preventDefault();e.stopImmediatePropagation();openAnnotation()}},true);
document.querySelectorAll('.photo').forEach(e=>{e.tabIndex=0;e.setAttribute('role','button');e.setAttribute('aria-label','查看并编辑照片标注');e.addEventListener('click',openAnnotation);e.addEventListener('keydown',ev=>{if(ev.key==='Enter')openAnnotation()})});
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;if(location.origin!=='null'&&e.origin!==location.origin)return;if(e.data?.type!=='haoli-annotation-saved'||typeof e.data.preview!=='string'||!e.data.preview.startsWith('data:image/png'))return;savedAnnotations=e.data.payload.shapes;document.querySelectorAll('.photo img').forEach(img=>img.src=e.data.preview);document.querySelectorAll('.photo').forEach(p=>p.classList.add('hide-marks'));document.querySelector('.photocaption span').textContent=`已标注 ${savedAnnotations.length} 处`;editorDialog.close();notify('标注已同步到核对与报告，原图仍保留')});
document.querySelector('#file').addEventListener('change',e=>{const f=e.target.files[0];if(!f||!f.type.startsWith('image/'))return;const reader=new FileReader();reader.onload=()=>{originalSource=reader.result;sourceKey=f.name+':'+f.size+':'+f.lastModified;savedAnnotations=[];frameInitialized=false;document.querySelector('.photocaption span').textContent='尚未标注'};reader.readAsDataURL(f)});
const system=document.createElement('section');system.className='systems';system.innerHTML=`<h2>细节也要是一套设计。</h2><p>同一套线性图标、控件形态与状态反馈；点击下方控件可查看反馈。卡片承载独立对象，正文与问题清单用分隔组织。</p><div class="component-grid"><article><h3>图标 / Lucide · 统一线宽</h3><div class="icon-strip">${[['camera','拍照'],['scan-line','标注'],['mic','录音'],['pencil','编辑'],['undo-2','撤销'],['share-2','分享']].map(([i,t])=>`<span>${icon(i)}${t}</span>`).join('')}</div><p>界面图标18–20px，功能配文字；不使用字符代替图标。</p></article><article><h3>操作 / 明确的主次与状态</h3><div class="button-demo"><button data-demo="已触发主操作反馈">确认保存</button><button data-demo="次操作用于返回或补充">稍后处理</button><button disabled>处理中</button></div><p class="demo-feedback" role="status">按下时轻微反馈；键盘焦点清晰可见。</p></article><article><h3>卡片 / 只承载一个完整对象</h3><div class="card-demo">${icon('file-check-2')}<div><strong>窗边巡查记录</strong><small>问题与照片对应 · 示例</small></div></div><div class="state-line">${icon('check')}<span>保存成功有文字反馈，不只闪一下。</span></div></article></div>`;
document.querySelector('.thesis').before(system);document.querySelectorAll('[data-demo]').forEach(b=>b.onclick=()=>document.querySelector('.demo-feedback').textContent=b.dataset.demo);
lucide.createIcons();
