const { test } = require('node:test');
const assert = require('node:assert/strict');
const cache = new Map();
global.wx = {getStorageSync:k=>cache.get(k),setStorageSync:(k,v)=>cache.set(k,structuredClone(v)),removeStorageSync:k=>cache.delete(k)};
const D = require('../miniprogram/utils/inspection-draft');
const M = require('../miniprogram/utils/inspection-model');
test('legacy and v2 preserve metadata, invalidate edited inputs, retain upload receipts',()=>{
 cache.clear(); const form={projectId:'p',issueDrafts:[{id:'photo',imagePath:'tmp',voiceText:'a'}]};
 D.writeDraft('s',form); D.patchDraft('s',{phase:'review',taskId:'t',review:{items:[]}});
 D.writeDraft('s',{...form,issueDrafts:[{...form.issueDrafts[0],imagePath:'cloud://x'}]});
 assert.equal(D.readDraft('s').phase,'review');assert.equal(D.readDraft('s').taskId,'t');
 D.writeDraft('s',{...form,note:'changed'});assert.equal(D.readDraft('s').phase,'capture');assert.equal(D.readDraft('s').taskId,'');
 cache.set('old',form);assert.equal(D.readDraft('old').form.projectId,'p');
 D.finishDraft('s');assert.equal(cache.has('s'),false);
});
test('stable photo binding survives reorder and resolves cloud images',()=>{
 const photos=[{id:'b',imagePath:'cloud://b'},{id:'a',imagePath:'cloud://a',annotatedImagePath:'cloud://marked'}];
 const rows=M.resolveIssueMedia([{id:'i',sourcePhotoId:'a',sourceIndex:0}],photos);
 assert.equal(rows[0].sourceIndex,1);assert.equal(rows[0].images[0],'cloud://a');assert.equal(rows[0].annotatedImages[0],'cloud://marked');
 assert.throws(()=>M.resolveIssueMedia([{sourcePhotoId:'missing',sourceIndex:0}],photos));
});
test('annotation changes retain human edits, submitted payload cannot silently change',()=>{
 cache.clear();const form={projectId:'p',issueDrafts:[{id:'photo',imagePath:'local'}]};D.writeDraft('s',form);
 D.patchDraft('s',{review:{items:[{id:'i',sourcePhotoId:'photo',description:'人工修改'}]}});
 D.writeDraft('s',{...form,issueDrafts:[{...form.issueDrafts[0],annotations:[{id:'mark'}]}]});
 assert.equal(D.readDraft('s').review.items[0].description,'人工修改');assert.equal(D.readDraft('s').review.stale,true);
 D.patchDraft('s',{submission:{requestId:'fixed'}});assert.throws(()=>D.writeDraft('s',{...form,note:'改写'}),/内容已锁定/);
});
test('account plus project plus session isolates drafts and retains siblings',()=>{
 cache.clear();let owner='a';global.getApp=()=>({globalData:{userInfo:{openId:owner}}});
 D.writeDraft('a1',{projectId:'A',note:'A原记录',issueDrafts:[]});
 D.writeDraft('b1',{projectId:'B',note:'B原记录',issueDrafts:[]});
 D.writeDraft('a2',{projectId:'A',note:'A新记录',issueDrafts:[]});
 assert.equal(D.listDrafts('A').length,2);assert.equal(D.listDrafts('B').length,1);
 D.finishDraft('a2');assert.equal(D.readDraft('a1').form.note,'A原记录');
 owner='b';assert.equal(D.readDraft('a1').form,null);assert.equal(D.listDrafts().length,0);
 assert.throws(()=>D.writeDraft('a1',{projectId:'A',note:'overwrite'}),/其他账号/);
 owner='';assert.equal(D.readDraft('a1').form,null);
 delete global.getApp;
});
