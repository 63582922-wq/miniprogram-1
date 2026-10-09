const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

const USER_DATA='/var/mobile/Containers/Data/Application/xx/Documents';
const ROOT=USER_DATA+'/';

/** 造一个假的 wx：记录 unlink 了哪些文件。 */
function fakeWx(savedFiles){
  const removed=[];
  const store=new Map();
  return {
    removed, store,
    env:{USER_DATA_PATH:USER_DATA},
    getStorageSync:k=>structuredClone(store.get(k)),
    setStorageSync:(k,v)=>store.set(k,structuredClone(v)),
    removeStorageSync:k=>store.delete(k),
    getFileSystemManager:()=>({unlink:({filePath,success})=>{removed.push(filePath);success&&success();}}),
    getSavedFileList:({success})=>success&&success({fileList:savedFiles}),
    getApp:()=>({globalData:{userInfo:{openId:'owner'}}})
  };
}

const loadUtil=(wx)=>{
  const module={exports:{}};
  vm.runInNewContext(read('miniprogram/utils/local-media.js'),{module,require:()=>({}),wx,Date});
  return module.exports;
};

test('one draft yields every local photo and voice file it owns',()=>{
  const {collectLocalMediaPaths}=loadUtil(fakeWx([]));
  const draft={form:{issueDrafts:[
    {localImagePath:ROOT+'a.jpg',localAnnotatedImagePath:ROOT+'a-marked.jpg',imagePath:'cloud://x/a.jpg'},
    {imagePath:ROOT+'b.jpg',voiceFilePath:ROOT+'b.mp3'}
  ]}};
  // 跨 vm realm 的数组原型不同，strict deepEqual 会判不等；先转成宿主数组
  const paths=Array.from(collectLocalMediaPaths(draft)).sort();
  assert.deepEqual(paths,[ROOT+'a-marked.jpg',ROOT+'a.jpg',ROOT+'b.jpg',ROOT+'b.mp3'].sort());
  // cloud:// 不是本机文件，绝不能进删除清单
  assert.equal(paths.includes('cloud://x/a.jpg'),false);
});

test('finishing a draft releases its local files instead of leaving them on the phone',()=>{
  const wx=fakeWx([]);
  const {releaseLocalMedia}=loadUtil(wx);
  return releaseLocalMedia({form:{issueDrafts:[{localImagePath:ROOT+'a.jpg'},{localImagePath:ROOT+'b.jpg'}]}})
    .then((count)=>{
      assert.equal(count,2);
      assert.deepEqual(wx.removed.sort(),[ROOT+'a.jpg',ROOT+'b.jpg'].sort());
    });
});

test('report submission actually calls the release path',()=>{
  const draft=read('miniprogram/utils/inspection-draft.js');
  assert.match(draft,/const \{ releaseLocalMedia \} = require\("\.\/local-media"\)/,
    '草稿模块要引入释放逻辑');
  assert.match(draft,/function finishDraft\(sessionKey\) \{[\s\S]{0,400}releaseLocalMedia\(readDraft\(sessionKey\)\)/,
    'finishDraft 必须先取草稿再释放——顺序反了就取不到照片路径');
  // 必须在清 storage 之前取，否则草稿已经没了
  const body=draft.slice(draft.indexOf('function finishDraft(sessionKey) {'));
  assert.ok(body.indexOf('releaseLocalMedia(readDraft')<body.indexOf('removeStorageSync(sessionKey)'),
    '释放要发生在清 storage 之前');
});

test('the sweep refuses to run until identity is confirmed',()=>{
  // 这是最危险的一条：草稿按 openId 归属，身份未知时所有草稿都读不出来，
  // 「没有草稿引用它」会对每一张照片成立，会把正在编辑的草稿照片一起删掉。
  const wx=fakeWx([{filePath:ROOT+'draft-photo.jpg',createTime:1}]);
  const {sweepOrphanLocalMedia}=loadUtil(wx);
  return sweepOrphanLocalMedia([]).then((count)=>{
    assert.equal(count,0,'没有 identityConfirmed 时不得删除任何文件');
    assert.deepEqual(wx.removed,[],'一张都不能删');
  });
});

test('the sweep removes old orphans but keeps referenced and fresh files',()=>{
  const nowSec=Math.floor(Date.now()/1000);
  const old=nowSec-3*24*60*60;
  const fresh=nowSec-60;
  const wx=fakeWx([
    {filePath:ROOT+'orphan-old.jpg',createTime:old},
    {filePath:ROOT+'still-referenced.jpg',createTime:old},
    {filePath:ROOT+'just-added.jpg',createTime:fresh}
  ]);
  const {sweepOrphanLocalMedia}=loadUtil(wx);
  const live=[{form:{issueDrafts:[{localImagePath:ROOT+'still-referenced.jpg'}]}}];
  return sweepOrphanLocalMedia(live,{identityConfirmed:true}).then((count)=>{
    assert.equal(count,1);
    assert.deepEqual(wx.removed,[ROOT+'orphan-old.jpg'],
      '只删「没人引用且足够旧」的：引用中的和刚拍的都要留下');
  });
});

test('the launch sweep waits for identity before it dares to delete anything',()=>{
  const app=read('miniprogram/app.js');
  assert.match(app,/if \(!currentOwner\(\)\) return;/,
    'app 启动清扫必须先确认已拿到用户身份');
  assert.match(app,/identityConfirmed:\s*true/,
    '确认身份后要显式告诉工具可以删');
});
