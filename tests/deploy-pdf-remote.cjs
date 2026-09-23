// Run only on the explicitly approved PDF host, as its existing service user.
// Never prints credentials; preserves the existing dependency install and PM2 env.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = '/home/ubuntu/report-pdf-service';
const archive = '/home/ubuntu/haoli-pdf-A-20260921.tgz';
const expectedHash = 'd09f4028a374c1eee51a32fe4809548e2481dd83c5029ff2ca208e8dbbe33e87';
const run = (cmd, args) => cp.execFileSync(cmd, args, {encoding:'utf8'});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  assert.equal(run('hostname', []).trim(), 'VM-0-15-ubuntu', 'Wrong server');
  const entry = JSON.parse(run('pm2', ['jlist'])).find(p => p.name === 'report-pdf-service');
  assert(entry && entry.pm2_env.status === 'online', 'Existing service is not online');
  assert.equal(entry.pm2_env.pm_exec_path, path.join(root, 'server.js'));
  const env = {...process.env, ...entry.pm2_env.env};
  for (const k of ['PDF_API_KEY','PUPPETEER_EXECUTABLE_PATH','PDF_ALLOWED_IMAGE_HOSTS','PDF_ALLOW_HTTP','PORT']) {
    if (entry.pm2_env[k] !== undefined) env[k] = String(entry.pm2_env[k]);
  }
  assert.notEqual(env.PDF_ALLOW_HTTP, 'true', 'HTTP image exception needs review');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), expectedHash);
  const listing = run('tar', ['-tzf', archive]).trim().split('\n');
  assert(listing.every(p => !p.startsWith('/') && !p.split('/').includes('..')));
  const backup = fs.mkdtempSync('/home/ubuntu/haoli-pdf-backup-');
  fs.chmodSync(backup, 0o700);
  run('tar', ['-czf', path.join(backup,'service.tgz'), '--exclude=node_modules', '-C', root, '.']);
  fs.writeFileSync(path.join(backup,'pm2-entry.json'), JSON.stringify(entry), {mode:0o600});
  const stage = fs.mkdtempSync('/home/ubuntu/haoli-pdf-stage-');
  run('tar', ['-xzf', archive, '-C', stage]);
  fs.symlinkSync(path.join(root,'node_modules'), path.join(stage,'node_modules'));
  run('node', ['--check', path.join(stage,'server.js')]);
  Object.assign(process.env, env);
  const payload = {title:'现场巡查报告', projectName:'QA隔离验收-服务器PDF',
    companyName:'毫厘智管', inspectionDateText:'2026-09-21', inspectorName:'隔离测试',
    testLabel:'隔离测试样本；不是真实客户报告；本样本不验证照片。',
    summary:'验证实际服务器中文字体、长文分页、异步任务和下载。',
    items:[{description:'第一页中文内容：窗框接缝需要人工复核。',suggestion:'仅用于服务验收。'},
      {description:'长文开始。'+ '现场质量记录必须保留人工确认内容，不自动宣称工程合格。'.repeat(120)+'长文结束。'}]};
  const {renderReportPdf} = require(path.join(stage,'src/render-report-pdf'));
  const pdf = Buffer.from(await renderReportPdf(payload));
  assert.equal(pdf.subarray(0,5).toString(), '%PDF-');
  fs.writeFileSync(path.join(backup,'staging-sample.pdf'), pdf);
  console.log(JSON.stringify({phase:'staging-passed',backup,stage,pdfBytes:pdf.length,keyPresent:!!env.PDF_API_KEY}));
  assert(env.PDF_API_KEY, 'Staging PDF generated, but existing PDF_API_KEY missing; running service unchanged');
  let changed = false;
  const base = 'http://127.0.0.1:' + (env.PORT || '3100');
  async function request(route, opts = {}, auth = true) {
    return fetch(base+route, {...opts, headers:{...(auth?{'X-API-Key':env.PDF_API_KEY}:{}),...opts.headers}, signal:AbortSignal.timeout(10000)});
  }
  try {
    changed = true;
    for (const file of ['server.js','src/render-report-pdf.js','src/report-template.js','src/url-guard.js']) fs.copyFileSync(path.join(stage,file),path.join(root,file));
    run('pm2',['restart','report-pdf-service']);
    let healthy = false;
    for(let i=0;i<15;i++){try {healthy=(await request('/health',{},false)).ok;}catch{} if(healthy)break; await sleep(1000);}
    assert(healthy, 'Health failed');
    assert.equal((await request('/api/report-pdf/tasks/qa',{},false)).status,401);
    const jobId = 'pdf-'+crypto.randomBytes(20).toString('hex');
    const opts = {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,jobId})};
    const created = await (await request('/api/report-pdf/tasks',opts)).json();
    assert.equal(created.data.taskId,jobId);
    const again = await (await request('/api/report-pdf/tasks',opts)).json();
    assert.equal(again.data.taskId,jobId);
    let task;
    for(let i=0;i<60;i++){task=await (await request('/api/report-pdf/tasks/'+jobId)).json(); if(['success','failed'].includes(task.data.status))break; await sleep(1000);}
    assert.equal(task.data.status,'success', task.data.errorMessage);
    const downloaded = Buffer.from(await (await request('/api/report-pdf/tasks/'+jobId+'/download')).arrayBuffer());
    assert.equal(downloaded.subarray(0,5).toString(),'%PDF-');
    const resultPath = path.join(backup,'remote-service-sample.pdf');
    fs.writeFileSync(resultPath,downloaded);
    const result={phase:'deployed-and-tested',backup,stage,jobId,resultPath,pdfBytes:downloaded.length,
      checks:['health','unauthorized-401','stable-jobId','async-success','download-pdf'],
      pending:['image-evidence','visual-review','public-HTTPS','cloud-to-service','WeChat-open']};
    fs.writeFileSync(path.join(backup,'acceptance.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify(result));
  } catch(error) {
    if(changed){run('tar',['-xzf',path.join(backup,'service.tgz'),'-C',root]);run('pm2',['restart','report-pdf-service']);console.error('Rolled back existing service files. Backup: '+backup);}
    throw error;
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
