const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');

async function loadProfile(user,company={},wx={}){
 let config;
 const cloudMedia={isCloudFileId:value=>typeof value==='string'&&value.startsWith('cloud://'),resolveCloudFileUrls:async ids=>{
  if(!wx.cloud||!wx.cloud.getTempFileURL)return {urls:{},failed:ids};
  try{const result=await wx.cloud.getTempFileURL({fileList:ids}),urls={},failed=[];(result.fileList||[]).forEach((file,index)=>{const id=ids[index];if(file.tempFileURL&&(file.status===undefined||file.status===0))urls[id]=file.tempFileURL;else failed.push(id);});return {urls,failed};}
  catch(_error){return {urls:{},failed:ids};}
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../miniprogram/pages/profile/index.js'),'utf8'),{
  Page:value=>{config=value;},
  require:id=>id.endsWith('/user')?{getCurrentUser:async()=>user}:id.endsWith('/settings')?{getSettings:async()=>company}:id.endsWith('/report-identity')?require('../miniprogram/utils/report-identity'):id.endsWith('/cloud-media')?cloudMedia:{syncTabBar(){}},
  wx,
  console
 });
 const page={...config,data:structuredClone(config.data),setData(next){Object.entries(next).forEach(([key,value])=>{if(!key.includes('.')){this.data[key]=value;return;}const [root,nested]=key.split('.');this.data[root]={...(this.data[root]||{}),[nested]:value};});}};
 await page.loadUser();
 return page.data;
}

test('profile does not count the legacy role nickname as a named inspector',async()=>{
 const data=await loadProfile({openId:'owner',nickname:'巡查员'});
 assert.equal(data.displayUserInfo.nickname,'');
 assert.equal(data.identity.hasInspector,false);
 assert.equal(data.identity.completeCount,0);
});

test('profile counts an actual inspector name without requiring company data',async()=>{
 const data=await loadProfile({openId:'owner',nickname:'陈工'});
 assert.equal(data.displayUserInfo.nickname,'陈工');
 assert.equal(data.identity.hasInspector,true);
 assert.equal(data.identity.completeCount,1);
});

test('profile resolves an uploaded cloud logo to a viewable temporary URL',async()=>{
 let requested;
 const data=await loadProfile({openId:'owner',nickname:'陈工'},{companyName:'木作事务所',logoFileId:'cloud://owner/logo.png'},
  {cloud:{getTempFileURL:async({fileList})=>{requested=fileList[0];return {fileList:[{status:0,tempFileURL:'https://temporary.example/logo.png'}]};}}});
 assert.equal(requested,'cloud://owner/logo.png');
 assert.equal(data.company.logoPreviewUrl,'https://temporary.example/logo.png');
 assert.equal(data.company.logoPreviewError,false);
 assert.equal(data.identity.hasLogo,true);
});

test('profile keeps uploaded-logo state when cloud preview is temporarily unavailable',async()=>{
 const data=await loadProfile({openId:'owner'},{logoFileId:'cloud://owner/logo.png'},
  {cloud:{getTempFileURL:async()=>({fileList:[{status:-1,tempFileURL:''}]})}});
 assert.equal(data.company.logoFileId,'cloud://owner/logo.png');
 assert.equal(data.company.logoPreviewUrl,'');
 assert.equal(data.company.logoPreviewError,true);
 assert.equal(data.identity.hasLogo,true);
});

test('profile distinguishes inspector phone from company contact fallback',async()=>{
 const inspector=await loadProfile({openId:'owner',phone:'13800000000'},{companyPhone:'010-12345678'});
 const company=await loadProfile({openId:'owner'},{companyPhone:'010-12345678'});
 assert.equal(inspector.contactLine,'巡查联系电话 · 13800000000');
 assert.equal(company.contactLine,'公司联系电话 · 010-12345678');
});
