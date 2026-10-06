const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {harness}=require('./cloud-harness.cjs');
const {isOwnedMedia,assertMedia,MEDIA_FOLDERS}=require('../cloudfunctions/report/reliable');
const root=path.resolve(__dirname,'..');
const FUNCTIONS=['ai','inspection','project','report'];

function walk(dir,out=[]){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='node_modules')continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())walk(full,out);else out.push(full);
  }
  return out;
}

test('every deploy package ships the same media ownership rule',()=>{
  const reference=fs.readFileSync(path.join(root,'cloudfunctions','ai','reliable.js'),'utf8');
  FUNCTIONS.forEach(name=>{
    const current=fs.readFileSync(path.join(root,'cloudfunctions',name,'reliable.js'),'utf8');
    assert.equal(current,reference,`cloudfunctions/${name}/reliable.js 与 ai 的副本不一致：四份必须同步，否则修一份不会传导`);
  });
});

test('the media folder allowlist still covers every folder the client uploads to',()=>{
  const used=new Set();
  for(const file of walk(path.join(root,'miniprogram'))){
    if(!file.endsWith('.js'))continue;
    const source=fs.readFileSync(file,'utf8');
    // 直接调用：uploadUserFile(path, "folder", ...)
    for(const match of source.matchAll(/uploadUserFile\(\s*[^,]+,\s*"([^"]+)"/g))used.add(match[1]);
  }
  // 采集上传用的是表格：["imagePath", "inspection-images", "localImagePath"]
  const mediaSource=fs.readFileSync(path.join(root,'miniprogram','services','inspection-media.js'),'utf8');
  for(const match of mediaSource.matchAll(/\[\s*"\w+",\s*"([a-z][a-z0-9-]+)",\s*"\w+"\s*\]/g))used.add(match[1]);

  assert.ok(used.size>=7,`上传目录抽取失效，只识别到 ${[...used].join(', ')}`);
  const missing=[...used].filter(folder=>!MEDIA_FOLDERS.has(folder));
  assert.deepEqual(missing,[],`客户端上传到了未在 MEDIA_FOLDERS 登记的目录：${missing.join(', ')}`);
});

test('ownership requires an exact openId segment, not a substring',()=>{
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner/a.png','owner'),true);
  // 前缀伪造：旧实现的 includes("/user/owner/") 会放行
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner_evil/a.png','owner'),false);
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/xowner/a.png','owner'),false);
  // 多一层别名前缀
  assert.equal(isOwnedMedia('cloud://env/archive/inspection-images/user/owner/a.png','owner'),false);
  // 文件名里再嵌一层
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner/sub/a.png','owner'),false);
  // 他人的目录
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/other/a.png','owner'),false);
  // 非媒体目录
  assert.equal(isOwnedMedia('cloud://env/unknown-folder/user/owner/a.png','owner'),false);
  // 穿越与编码
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner/../other.png','owner'),false);
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner/a%2fb.png','owner'),false);
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner/a%2Eb.png','owner'),false);
  assert.equal(isOwnedMedia('https://example.com/a.png','owner'),false);
  assert.equal(isOwnedMedia('cloud://env/inspection-images/user/owner/a.png',''),false);
});

test('assertMedia keeps rejecting what it always rejected and adds the forgery forms',()=>{
  assert.doesNotThrow(()=>assertMedia('cloud://env/inspection-images/user/owner/a.png','owner'));
  assert.doesNotThrow(()=>assertMedia('','owner'),'未上传的空引用仍按缺省放行');
  assert.doesNotThrow(()=>assertMedia(undefined,'owner'));
  assert.throws(()=>assertMedia('http://example.com/a.png','owner'),/不属于当前用户/);
  assert.throws(()=>assertMedia('cloud://env/inspection-images/user/owner_evil/a.png','owner'),/不属于当前用户/);
  assert.throws(()=>assertMedia('cloud://env/archive/inspection-images/user/owner/a.png','owner'),/不属于当前用户/);
});

test("a stored logo that is not the author's is never signed for a share reader",async()=>{
  const h=harness();
  h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});
  h.table('reports').set('r',{_id:'r',projectId:'p',createdBy:'owner',deleted:false,shareState:'active',
    shareToken:'share-token-1234567890abcdef',snapshotVersion:2,
    logoFileId:'cloud://env/logos/user/victim/secret.png',
    snapshot:{items:[],photos:[],title:'报告',projectName:'项目'}});
  const report=h.load('report');

  h.as('recipient');
  const read=await report({action:'detail',payload:{reportId:'r',shareToken:'share-token-1234567890abcdef'}});
  assert.equal(read.success,true);
  assert.equal(read.data.accessMode,'shared');
  assert.equal(read.data.logoFileId,'','他人的 LOGO 引用必须在签发前被剔除');
  assert.deepEqual(h.calls.tempFileUrls,[],"不能为不属于作者的文件申请临时链接");
});

test('an owned logo still reaches the share reader',async()=>{
  const h=harness();
  h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});
  h.table('reports').set('r',{_id:'r',projectId:'p',createdBy:'owner',deleted:false,shareState:'active',
    shareToken:'share-token-1234567890abcdef',snapshotVersion:2,
    logoFileId:'cloud://env/logos/user/owner/mine.png',
    snapshot:{items:[],photos:[],title:'报告',projectName:'项目'}});
  const report=h.load('report');

  h.as('recipient');
  const read=await report({action:'detail',payload:{reportId:'r',shareToken:'share-token-1234567890abcdef'}});
  assert.equal(read.success,true);
  assert.deepEqual(h.calls.tempFileUrls,['cloud://env/logos/user/owner/mine.png']);
  assert.match(read.data.logoFileId,/example\.com/,'归属正确的 LOGO 仍应换成临时链接');
});

test('the client cannot write a logo it does not own, and legacy unscoped logos are dropped',async()=>{
  const h=harness();
  h.table('projects').set('p',{_id:'p',name:'项目',ownerOpenId:'owner',deleted:false});
  h.table('reports').set('r',{_id:'r',projectId:'p',createdBy:'owner',deleted:false,status:'draft'});
  const report=h.load('report');

  const foreign=await report({action:'save',payload:{reportId:'r',title:'t',logoFileId:'cloud://env/logos/user/victim/secret.png'}});
  assert.equal(foreign.success,true);
  assert.equal(foreign.data.logoFileId,'');
  assert.equal(h.table('reports').get('r').logoFileId,'',"库里也不能留下他人的 fileID");

  // 2026-09-15 之前上传的旧 logo 没有 user/{openId}/ 前缀：丢弃而不是让报告发不出去。
  const legacy=await report({action:'save',payload:{reportId:'r',title:'t',logoFileId:'cloud://env/logos/1699999999999.png'}});
  assert.equal(legacy.success,true);
  assert.equal(legacy.data.logoFileId,'');

  const owned=await report({action:'save',payload:{reportId:'r',title:'t',logoFileId:'cloud://env/logos/user/owner/mine.png'}});
  assert.equal(owned.data.logoFileId,'cloud://env/logos/user/owner/mine.png');
});
