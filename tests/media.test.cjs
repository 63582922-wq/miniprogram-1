const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('media failure preserves completed receipts, retry uploads only incomplete file',async()=>{
 let calls=[],once=true,module={exports:{}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/inspection-media'),'utf8'),{module,require:()=>({uploadUserFile:async(path)=>{calls.push(path);if(path==='b'&&once){once=false;throw Error('upload failed');}return 'cloud://'+path;}}),wx:{}});
 let saved;const upload=module.exports.uploadDraftMedia,form={issueDrafts:[{id:'1',imagePath:'a'},{id:'2',imagePath:'b'}]};
 await assert.rejects(upload(form,async p=>{saved=structuredClone(p);}),/upload failed/);
 assert.equal(saved.issueDrafts[0].imagePath,'cloud://a');await upload(saved);assert.deepEqual(calls,['a','b','b']);
 await assert.rejects(upload({issueDrafts:[{imagePath:'a',annotationDirty:true}]}),/标注尚未导出/);
});
