const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

function loadService(wx){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../miniprogram/services/cloud-media.js'),'utf8'),
  {module,exports:module.exports,wx,Array,Set,Object,String,Promise});
 return module.exports;
}

test('cloud media resolver deduplicates IDs, batches safely and returns display URLs only',async()=>{
 const calls=[];
 const service=loadService({cloud:{getTempFileURL:async({fileList})=>{
  calls.push(fileList);
  return {fileList:fileList.map(fileID=>({fileID,status:0,tempFileURL:`https://temporary.example/${encodeURIComponent(fileID)}`}))};
 }}});
 const ids=Array.from({length:53},(_,index)=>`cloud://env/${index}.png`);
 const result=await service.resolveCloudFileUrls([...ids,ids[0],'https://already-public.example/photo.jpg']);
 assert.deepEqual(calls.map(batch=>batch.length),[50,3]);
 assert.equal(Object.keys(result.urls).length,53);
 assert.equal(result.urls[ids[0]],`https://temporary.example/${encodeURIComponent(ids[0])}`);
 assert.deepEqual([...result.failed],[]);
 assert.equal(service.isCloudFileId(ids[0]),true);
 assert.equal(service.isCloudFileId('https://example.com/image.jpg'),false);
});

test('cloud media resolver isolates per-file failure and reports service unavailability',async()=>{
 const service=loadService({cloud:{getTempFileURL:async({fileList})=>({fileList:fileList.map(fileID=>({fileID,status:fileID.endsWith('bad.png')?-1:0,tempFileURL:fileID.endsWith('bad.png')?'':`https://temporary.example/${fileID}`}))})}});
 const result=await service.resolveCloudFileUrls(['cloud://env/good.png','cloud://env/bad.png']);
 assert.equal(result.urls['cloud://env/good.png'],'https://temporary.example/cloud://env/good.png');
 assert.deepEqual([...result.failed],['cloud://env/bad.png']);
 const unavailable=loadService({}).resolveCloudFileUrls(['cloud://env/no-cloud.png']);
 assert.deepEqual([...(await unavailable).failed],['cloud://env/no-cloud.png']);
});
