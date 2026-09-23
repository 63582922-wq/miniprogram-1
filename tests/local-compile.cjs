const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['node_modules','.git'].includes(e.name)?files(path.join(dir,e.name)):e.isFile()?[path.join(dir,e.name)]:[]);}
const all=['miniprogram','cloudfunctions','report-pdf-service'].flatMap(d=>files(path.join(root,d)));
let failures=0;
for(const p of all.filter(p=>p.endsWith('.js'))){const r=cp.spawnSync(process.execPath,['--check',p],{encoding:'utf8'});if(r.status){failures++;console.error(p,r.stderr);}}
for(const p of all.filter(p=>p.endsWith('.json'))){try{JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){failures++;console.error(p,e.message);}}
const compiler='/Applications/wechatwebdevtools.app/Contents/Resources/app.asar.unpacked/node_modules/wcc-exec/';
for(const [ext,bin]of [['.wxml','wcc'],['.wxss','wcsc']]){
  const names=all.filter(p=>p.endsWith(ext));
  const r=cp.spawnSync(compiler+bin,names,{cwd:path.join(root,'miniprogram'),encoding:'utf8',maxBuffer:30*1024*1024});
  if(r.status){failures++;console.error(bin,r.stderr||r.error||r.stdout.slice(0,2000));}
  console.log(bin+': '+names.length+' files; '+(r.status?'FAIL':'PASS'));
}
console.log('JavaScript/JSON/native template checks: '+(failures?'FAIL':'PASS'));
process.exitCode=failures?1:0;
