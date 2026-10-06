const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

test('report cover binds to presentation URL and exposes recoverable media failure',()=>{
 const wxml=fs.readFileSync(path.resolve(__dirname,'../miniprogram/pages/report/detail/index.wxml'),'utf8');
 assert.match(wxml,/src="\{\{report\.logoPreviewUrl\}\}"/);
 assert.doesNotMatch(wxml,/src="\{\{report\.logoFileId\}\}"/);
 assert.match(wxml,/handleReportImageError/);
 assert.match(wxml,/照片暂时无法加载/);
 assert.match(wxml,/bindtap="loadReport">重新加载/);
});

function loadReportPage(wx,serviceOverrides={}){
 let config;
 const cloudMedia={isCloudFileId:value=>typeof value==='string'&&value.startsWith('cloud://'),resolveCloudFileUrls:async ids=>{
  if(!wx.cloud||!wx.cloud.getTempFileURL)return {urls:{},failed:ids};
  try{const result=await wx.cloud.getTempFileURL({fileList:ids}),urls={},failed=[];ids.forEach((id,index)=>{const file=(result.fileList||[]).find(item=>item.fileID===id)||(result.fileList||[])[index]||{};if(file.tempFileURL&&(file.status===undefined||file.status===0))urls[id]=file.tempFileURL;else failed.push(id);});return {urls,failed};}
  catch(_error){return {urls:{},failed:ids};}
 }};
 const modules={
  '../../../services/report':{getReportDetail(){},buildReportData(){},saveReport(){},createReportShareToken(){},revokeReportShareToken(){},...serviceOverrides},
  '../../../services/settings':{getSettings(){}},
  '../../../utils/format':{mapSeverityText(){},mapResponsiblePartyText(){},formatDate(){},formatDateTime(){},toChineseSectionNumber(){},usesEditorialTypeface(){return false;}},
  '../../../utils/router':{decodeReturnContext(){},returnToContext(){}},
  '../../../utils/guide':{markGuideStep(){}},
  '../../../utils/system':{getWindowInfo:()=>typeof wx.getWindowInfo==='function'?wx.getWindowInfo():{windowWidth:375}},
  '../../../services/cloud-media':cloudMedia
 };
 const filename=path.resolve(__dirname,'../miniprogram/pages/report/detail/index.js');
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{Page:value=>config=value,wx,console,Date,Math,setTimeout,clearTimeout,
  require:id=>modules[id]||require(path.resolve(path.dirname(filename),id))});
 const page={...config,reportPreviewGeneration:1,data:{reportId:'report-1',report:{_id:'report-1',logoFileId:'cloud://env/logo.png',issueGroups:[]}},setData(patch){
  Object.entries(patch).forEach(([key,value])=>{
   if(!key.includes('.')){this.data[key]=value;return;}
   const [root,nested]=key.split('.');this.data[root]={...(this.data[root]||{}),[nested]:value};
  });
 }};
 return page;
}

test('report resolves cloud logo and issue photo as view-only URLs without changing frozen file IDs',async()=>{
 let requested;
 const page=loadReportPage({cloud:{getTempFileURL:async({fileList})=>{requested=fileList;return {fileList:fileList.map((fileID,index)=>({fileID,status:0,tempFileURL:`https://temporary.example/${index}.png`}))};}}});
 const report={_id:'report-1',logoFileId:'cloud://env/logo.png',issueGroups:[{key:'photo-1',image:'cloud://env/photo.png',issues:[]}]};
 page.data.report=report;
 await page.resolveReportPreviewMedia(1,report);
 assert.deepEqual([...requested],['cloud://env/logo.png','cloud://env/photo.png']);
 assert.equal(page.data.report.logoPreviewUrl,'https://temporary.example/0.png');
 assert.equal(page.data.report.issueGroups[0].image,'https://temporary.example/1.png');
 assert.equal(page.data.report.logoFileId,'cloud://env/logo.png','presentation URL must not overwrite immutable report data');
 assert.equal(page.data.report.logoPreviewError,false);
});

test('report image layout uses modern window info and does not call deprecated aggregate system info',async()=>{
 let legacyCalls=0;
 const page=loadReportPage({
  getWindowInfo:()=>({windowWidth:390}),
  getSystemInfoSync:()=>{legacyCalls++;throw new Error('deprecated API should not be called');}
 });
 const report={_id:'report-modern-window',logoFileId:'',issueGroups:[]};
 await page.resolveReportPreviewMedia(1,report);
 assert.equal(legacyCalls,0);
});

test('late logo response cannot paint a different report after navigation',async()=>{
 let finish;
 const page=loadReportPage({cloud:{getTempFileURL:()=>new Promise(resolve=>{finish=resolve;})}});
 const report=page.data.report;
 const pending=page.resolveReportPreviewMedia(1,report);
 page.reportPreviewGeneration=2;
 page.data.reportId='report-2';
 page.data.report={logoFileId:'cloud://env/other.png'};
 finish({fileList:[{status:0,tempFileURL:'https://temporary.example/old-logo.png'}]});
 await pending;
 assert.equal(page.data.report.logoPreviewUrl,undefined);
 assert.equal(page.data.report.logoFileId,'cloud://env/other.png');
});

test('late share-card image response cannot replace the current report image',async()=>{
 let finish;
 const page=loadReportPage({cloud:{getTempFileURL:()=>new Promise(resolve=>{finish=resolve;})}});
 page.data.reportId='report-1';
 page.data.report={_id:'report-1'};
 const pending=page.prepareShareImage({_id:'report-1',items:[{images:['cloud://env/old-cover.jpg']}]});
 page.reportPreviewGeneration=2;
 page.data.reportId='report-2';
 page.data.report={_id:'report-2'};
 page.data.shareImageUrl='https://temporary.example/current-cover.jpg';
 finish({fileList:[{status:0,tempFileURL:'https://temporary.example/old-cover.jpg'}]});
 await pending;
 assert.equal(page.data.shareImageUrl,'https://temporary.example/current-cover.jpg');
});

test('report without photos clears a stale share-card image',async()=>{
 const page=loadReportPage({});
 page.data.shareImageUrl='https://temporary.example/previous-cover.jpg';
 page.data.report={_id:'report-1'};
 await page.prepareShareImage({_id:'report-1',items:[]});
 assert.equal(page.data.shareImageUrl,'');
});

test('share management uses the in-app confirmation panel and reports recoverable failures',async()=>{
 let nativePrompts=0;
 let rotateCalled=0;
 const page=loadReportPage({
  showActionSheet(){nativePrompts++;},
  showModal(){nativePrompts++;},
  showToast(){}
 },{
  createReportShareToken:async(id,rotate)=>{assert.equal(id,'report-1');assert.equal(rotate,true);rotateCalled++;throw new Error('network unavailable');}
 });
 page.data.isOwner=true;
 page.data.reportId='report-1';
 page.data.report={_id:'report-1',shareToken:'active-token',shareState:'active'};
 page.manageShare();
 assert.equal(page.data.sharePanelOpen,true);
 assert.equal(page.data.shareChoices.map(choice=>choice.key).join(','),'revoke,rotate');
 assert.equal(nativePrompts,0,'native white action sheet/modal must not interrupt the report paper UI');
 page.chooseShareAction({currentTarget:{dataset:{action:'rotate'}}});
 assert.equal(page.data.sharePanelMode,'confirm');
 assert.equal(page.data.shareConfirmDanger,false);
 await page.confirmShareAction();
 assert.equal(rotateCalled,1);
 assert.equal(page.data.sharePanelMode,'error');
 assert.match(page.data.shareActionError,/network unavailable/);
 assert.equal(page.data.sharePanelOpen,true,'failure must leave an in-context retry path');
 assert.equal(nativePrompts,0);
});
