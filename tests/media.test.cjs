const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('media failure preserves completed receipts, retry uploads only incomplete file',async()=>{
 let calls=[],once=true,module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{module,require:()=>({uploadUserFile:async(path)=>{calls.push(path);if(path==='b'&&once){once=false;throw Error('upload failed');}return 'cloud://'+path;}}),wx:{}});
 let saved;const upload=module.exports.uploadDraftMedia,form={issueDrafts:[{id:'1',imagePath:'a'},{id:'2',imagePath:'b'}]};
 await assert.rejects(upload(form,async p=>{saved=structuredClone(p);}),/upload failed/);
 assert.equal(saved.issueDrafts[0].imagePath,'cloud://a');await upload(saved);assert.deepEqual(calls,['a','b','b']);
 await assert.rejects(upload({issueDrafts:[{imagePath:'a',annotationDirty:true}]}),/标注尚未导出/);
});

test('media upload uses a bounded parallel window and reports durable progress by file',async()=>{
 let active=0,maximum=0,module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{
  module,
  require:()=>({uploadUserFile:async(path)=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,3));active--;return `cloud://${path}`;}}),
  wx:{env:{USER_DATA_PATH:'/user'}}
 });
 const source={issueDrafts:Array.from({length:8},(_,index)=>({id:`p${index}`,imagePath:`/tmp/${index}.jpg`}))};
 const checkpoints=[];
 const result=await module.exports.uploadDraftMedia(source,(snapshot,progress)=>{checkpoints.push({snapshot,progress});},3);
 assert.equal(maximum,3);
 assert.equal(result.issueDrafts.filter(photo=>photo.imagePath.startsWith('cloud://')).length,8);
 assert.equal(source.issueDrafts.filter(photo=>photo.imagePath.startsWith('cloud://')).length,0,'source draft is not mutated in place');
 assert.equal(checkpoints.length,8);
 assert.deepEqual(checkpoints.map(item=>item.progress.completedFiles),[1,2,3,4,5,6,7,8]);
 assert.ok(checkpoints.every(item=>item.progress.totalFiles===8));
 assert.equal(checkpoints.at(-1).progress.percent,100);
});

test('inspection media passes stable identity keys so a lost upload response can be retried idempotently',async()=>{
 let calls=[],module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{
  module,
  require:()=>({uploadUserFile:async(path,folder,fileName,options)=>{calls.push({path,folder,fileName,options});return `cloud://${folder}/${fileName}`;}}),
  wx:{env:{USER_DATA_PATH:'/user'}}
 });
 await module.exports.uploadDraftMedia({issueDrafts:[{id:'photo/1',mediaRevision:3,annotationRevision:7,imagePath:'/tmp/photo.jpg',annotatedImagePath:'/tmp/marked.png',voiceFilePath:'/tmp/note.mp3'}]});
 assert.deepEqual(calls.map(item=>item.options.stableKey),[
  'photo/1-3-imagePath',
  'photo/1-7-annotatedImagePath',
  'photo/1-3-voice'
 ]);
});

test('resumed media upload with no pending files does not report a fake 1/0 progress step',async()=>{
 let progressCalls=0,module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{
  module,
  require:()=>({uploadUserFile:async()=>{throw new Error('should not upload')}}),
  wx:{env:{USER_DATA_PATH:'/user'}}
 });
 const result=await module.exports.uploadDraftMedia({issueDrafts:[{id:'p1',imagePath:'cloud://bucket/p1.png'}]},()=>{progressCalls+=1;});
 assert.equal(progressCalls,0);
 assert.equal(result.issueDrafts[0].imagePath,'cloud://bucket/p1.png');
});

/** 上传前压缩：只压长边超 2000px 的，任何异常都退回原图。 */
async function runCompress(info, result){
  const uploaded=[];
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{
    module,
    require:()=>({uploadUserFile:async(path)=>{uploaded.push(path);return `cloud://${path}`;}}),
    wx:{
      env:{USER_DATA_PATH:'/user'},
      getImageInfo:o=>info==='fail'?o.fail({}):o.success(info),
      compressImage:o=>result==='fail'?o.fail({}):o.success({tempFilePath:'/compressed.jpg'})
    }
  });
  await module.exports.uploadDraftMedia({issueDrafts:[{id:'p1',imagePath:'/tmp/photo.jpg'}]});
  return uploaded[0];
}

test('oversized photos are compressed down to the 2000px long edge before upload',async()=>{
  const path=await runCompress({width:4000,height:3000},'ok');
  assert.equal(path,'/compressed.jpg','a 4000px original must not be uploaded as-is');
  const portrait=await runCompress({width:3000,height:4000},'ok');
  assert.equal(portrait,'/compressed.jpg','portrait orientation is judged by its long edge too');
});

test('photos already within 2000px are uploaded untouched',async()=>{
  const path=await runCompress({width:1600,height:1200},'ok');
  assert.equal(path,'/tmp/photo.jpg','re-encoding an already-small photo only adds loss');
});

test('compression failure never blocks the record: the original is uploaded instead',async()=>{
  assert.equal(await runCompress({width:4000,height:3000},'fail'),'/tmp/photo.jpg','compress failure falls back');
  assert.equal(await runCompress('fail','ok'),'/tmp/photo.jpg','unreadable size falls back');
});

test('a client without compressImage keeps working (older base library)',async()=>{
  const uploaded=[];
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{
    module,
    require:()=>({uploadUserFile:async(path)=>{uploaded.push(path);return `cloud://${path}`;}}),
    wx:{env:{USER_DATA_PATH:'/user'}}
  });
  await module.exports.uploadDraftMedia({issueDrafts:[{id:'p1',imagePath:'/tmp/photo.jpg'}]});
  assert.equal(uploaded[0],'/tmp/photo.jpg');
});
