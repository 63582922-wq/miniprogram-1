const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

test('user-scoped upload path is stable only when an explicit media identity is supplied',()=>{
 const module={exports:{}};
 const clock={now:0};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/services/cloud'),'utf8'),{
  module,
  getApp:()=>({globalData:{userInfo:{openId:'owner'}}}),
  wx:{cloud:{}},
  Date:{now:()=>++clock.now},
  setTimeout
 });
 const paths=module.exports;
 const first=paths.buildUserScopedPath('inspection-images','photo.png',{stableKey:'photo/1-3-imagePath'});
 const second=paths.buildUserScopedPath('inspection-images','photo.png',{stableKey:'photo/1-3-imagePath'});
 const changed=paths.buildUserScopedPath('inspection-images','photo.png',{stableKey:'photo/1-4-imagePath'});
 assert.equal(first,second);
 assert.notEqual(first,changed);
 assert.match(first,/inspection-images\/user\/owner\/photo-1-3-imagePath-photo\.png$/);
 const unsafe=paths.buildUserScopedPath('inspection-images','legacy/photo.png',{stableKey:'legacy/photo'});
 assert.match(unsafe,/inspection-images\/user\/owner\/legacy-photo-legacy-photo\.png$/);
 const legacyA=paths.buildUserScopedPath('inspection-images','photo.png');
 const legacyB=paths.buildUserScopedPath('inspection-images','photo.png');
 assert.notEqual(legacyA,legacyB);
});
