const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadPage}=require('./page-harness.cjs');
const flush=()=>new Promise(r=>setImmediate(r));

/**
 * 项目详情页要能看到「这个项目的历史报告」。
 *
 * 数据其实早就取回来了——getProjectDetail 一直带 reports 字段，
 * 页面里也一直有一行 `const reports = ...`，但**只算不用**，
 * 所以这个工地出过几份报告，只能回「报告」tab 里翻。
 */
const WX={navigateTo:o=>{},showToast:()=>{},showModal:()=>{},getWindowInfo:()=>({statusBarHeight:20,windowWidth:375,windowHeight:667,safeArea:{top:20,bottom:667}}),getSystemInfoSync:()=>({statusBarHeight:20,windowWidth:375,windowHeight:667,platform:"ios"}),getMenuButtonBoundingClientRect:()=>({top:24,left:280,width:80,height:32}),getStorageSync:()=>"",setStorageSync:()=>{},removeStorageSync:()=>{}};

function mount({reports=[],navigated=[]}={}){
  // loadPage 只把 wx 注入页面沙箱；页面 require 进来的 utils/services
  // 跑在真实 Node 上下文里，读不到那个 wx，会在 loadDetail 里抛
  // 「wx is not defined」，把 loadError 填上——测试会误判成功能没做。
  global.wx = WX;
  const detail={
    project:{_id:'p1',name:'示例小区 3-1802',address:'成都',clientName:'谭'},
    inspections:[],
    reports
  };
  const {page}=loadPage('project/detail',{
    '../../../services/project':{
      getProjectDetail:async()=>detail,
      getProjectGallery:async()=>({photos:[]})
    },
    '../../../services/inspection':{cancelInspectionTask:async()=>({status:'cancelled'})},
    '../../../services/inspection-media':{keepLocalFile:async p=>p}
  },{
    navigateTo:o=>navigated.push(o.url),
    showToast:()=>{},showModal:()=>{},
    // 页面在 loadDetail 里会读窗口信息算安全区，缺了会抛 wx is not defined，
    // loadError 被填上、后面的 setData 根本不会执行——测试会误以为是功能没做。
    getWindowInfo:()=>({statusBarHeight:20,windowWidth:375,windowHeight:667,safeArea:{top:20,bottom:667}}),
    getSystemInfoSync:()=>({statusBarHeight:20,windowWidth:375,windowHeight:667,platform:'ios'}),
    getMenuButtonBoundingClientRect:()=>({top:24,bottom:56,left:280,right:360,width:80,height:32}),
    getStorageSync:()=>'',setStorageSync:()=>{},removeStorageSync:()=>{}
  });
  return {page,navigated};
}

test('项目详情页列出本项目的历史报告',async()=>{
  const {page}=mount({reports:[
    {_id:'r2',title:'3-1802 第二次巡查',publishedAt:2000,deleted:false},
    {_id:'r1',title:'3-1802 第一次巡查',publishedAt:1000,deleted:false}
  ]});
  page.setData({projectId:'p1'});
  await page.loadDetail();await flush();
  assert.equal(page.data.reports.length,2,'两份报告都应进入 data');
  assert.equal(page.data.reports[0]._id,'r2','最近的排前面（沿用服务端顺序）');
  assert.ok(page.data.reports[0].timeText,'每条要有可显示的时间');
});

test('已删除的报告不出现在历史里',async()=>{
  const {page}=mount({reports:[
    {_id:'r2',title:'还在的',publishedAt:2000,deleted:false},
    {_id:'r1',title:'删掉的',publishedAt:1000,deleted:true}
  ]});
  page.setData({projectId:'p1'});
  await page.loadDetail();await flush();
  assert.equal(page.data.reports.length,1);
  assert.equal(page.data.reports[0]._id,'r2','软删的报告不该列出来');
});

test('没有报告时不显示这一块',async()=>{
  const {page}=mount({reports:[]});
  page.setData({projectId:'p1'});
  await page.loadDetail();await flush();
  assert.deepEqual(page.data.reports,[],'没有报告时 data 为空，wx:if 会整块收起');
});

test('点历史报告能进详情页',async()=>{
  const navigated=[];
  const {page}=mount({reports:[{_id:'r2',title:'报告',publishedAt:2000,deleted:false}],navigated});
  page.setData({projectId:'p1'});
  await page.loadDetail();await flush();
  page.openReport({currentTarget:{dataset:{report:'r2'}}});
  assert.equal(navigated.length,1,'应跳转一次');
  assert.match(navigated[0],/\/pages\/report\/detail\/index\?reportId=r2/);
});

test('页面标记里确实有「历史报告」这一块，且绑定到 openReport',()=>{
  const fs=require('fs');
  const wxml=fs.readFileSync('miniprogram/pages/project/detail/index.wxml','utf8');
  assert.match(wxml,/历史报告/,'项目详情页要有「历史报告」标题');
  assert.match(wxml,/wx:for="\{\{reports\}\}"/,'要遍历 reports');
  assert.match(wxml,/bindtap="openReport"/,'每条要绑到 openReport');
});
