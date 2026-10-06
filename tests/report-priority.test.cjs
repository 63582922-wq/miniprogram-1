const {test}=require('node:test'),assert=require('node:assert/strict');
const {loadPage}=require('./page-harness.cjs');

const stubs={
  '../../../services/report':{
    getReportDetail:async()=>({}),
    buildReportData:async()=>({}),
    createReportShareToken:async()=>({}),
    revokeReportShareToken:async()=>({})
  },
  '../../../services/cloud-media':{
    isCloudFileId:()=>false,
    resolveCloudFileUrls:async()=>({urls:{},failed:[]})
  },
  '../../../utils/format':{
    mapResponsiblePartyText:v=>v||"",
    formatDateTime:()=>"",
    usesEditorialTypeface:()=>false
  },
  '../../../utils/router':{
    decodeReturnContext:()=>null,
    returnToContext:()=>{}
  },
  '../../../utils/guide':{markGuideStep:()=>{}}
};

function mount(scrollResponse){
  const calls={scrolled:[]};
  const {page,context}=loadPage('report/detail',stubs,{
    createSelectorQuery:()=>({
      select(){return this;},
      boundingClientRect(){return this;},
      selectViewport(){return this;},
      scrollOffset(){return this;},
      exec(callback){callback(scrollResponse);}
    }),
    pageScrollTo:options=>calls.scrolled.push(options)
  });
  return {page,context,calls};
}

const photo=(id)=>({id,imagePath:`cloud://env/inspection-images/user/owner/${id}.png`});
const issue=(overrides)=>({sourcePhotoId:'photo-1',severity:'normal',...overrides});

test('only the issues that are not routine are promoted to the summary',()=>{
  const {context}=mount(null);
  const report={
    _id:'report-priority',publishedAt:Date.UTC(2026,9,1),
    photos:[photo('photo-1'),photo('photo-2')],
    items:[
      issue({severity:'normal',description:'一般问题'}),
      issue({sourcePhotoId:'photo-2',severity:'critical',description:'严重问题'}),
      issue({severity:'major',description:'较重问题'})
    ]
  };
  const display=context.buildReportDisplayState(report);
  assert.deepEqual(Array.from(display.priorityItems,item=>item.severityText),['严重','较重'],
    '一般的条目不该出现在首屏清单里，严重的排在较重前面');
  assert.deepEqual(Array.from(display.priorityItems,item=>item.groupIndex),[1,0],
    '每一项都要带上它所在的照片分组序号，否则跳转会跳错');
  assert.equal(display.priorityOmitted,0);
});

test('a report with nothing but routine issues shows no priority block',()=>{
  const {context}=mount(null);
  const display=context.buildReportDisplayState({
    _id:'report-calm',publishedAt:Date.UTC(2026,9,1),
    photos:[photo('photo-1')],
    items:[issue({severity:'normal',description:'一般问题'})]
  });
  assert.deepEqual(Array.from(display.priorityItems),[]);
  assert.equal(display.priorityOmitted,0);
});

test('a report with no issues at all shows no priority block',()=>{
  const {context}=mount(null);
  const display=context.buildReportDisplayState({_id:'report-empty',publishedAt:Date.UTC(2026,9,1),photos:[],items:[]});
  assert.deepEqual(Array.from(display.priorityItems),[]);
});

test('the priority list is capped so the summary stays scannable, and the rest is counted',()=>{
  const {context}=mount(null);
  const display=context.buildReportDisplayState({
    _id:'report-many',publishedAt:Date.UTC(2026,9,1),
    photos:[photo('photo-1')],
    items:Array.from({length:7},(_,i)=>issue({severity:'critical',description:`严重问题 ${i}`}))
  });
  assert.equal(display.priorityItems.length,4,'首屏最多列 4 条');
  assert.equal(display.priorityOmitted,3,'其余条目要报数，不能默默丢掉');
});

test('long descriptions are shortened in the summary but the original text stays in the report',()=>{
  const {context}=mount(null);
  const long='主卧飘窗台面收口处存在约 2mm 缝隙，木饰面与石材交接不顺，需要现场复核后重新收口处理。';
  const display=context.buildReportDisplayState({
    _id:'report-long',publishedAt:Date.UTC(2026,9,1),
    photos:[photo('photo-1')],
    items:[issue({severity:'critical',description:long})]
  });
  assert.ok(display.priorityItems[0].description.endsWith('…'));
  assert.ok(display.priorityItems[0].description.length<long.length);
  assert.equal(display.issueGroups[0].issues[0].description,long,'完整描述必须原样留在下方问题里');
});

test('tapping a priority row scrolls to that photo group, clear of the fixed navigation',()=>{
  // 分组在文档里的绝对位置 800，当前已滚动 300，导航占 88。
  const {page,calls}=mount([{top:800},{scrollTop:300}]);
  page.reportNavHeight=88;
  page.handleJumpToGroup({currentTarget:{dataset:{group:2}}});
  // 只比数值：页面代码跑在隔离 vm 里，对象原型与测试进程不同。
  assert.equal(calls.scrolled.length,1);
  assert.equal(calls.scrolled[0].scrollTop,300+800-88-12);
  assert.equal(calls.scrolled[0].duration,260);
});

test('an unusable scroll measurement does not throw or scroll somewhere wrong',()=>{
  const {page,calls}=mount(null);
  page.reportNavHeight=88;
  page.handleJumpToGroup({currentTarget:{dataset:{group:1}}});
  assert.equal(calls.scrolled.length,0,'拿不到位置时宁可不跳，也不能跳到错误的地方');
});

test('an invalid group index is ignored',()=>{
  const {page,calls}=mount([{top:100},{scrollTop:0}]);
  page.handleJumpToGroup({currentTarget:{dataset:{}}});
  page.handleJumpToGroup({currentTarget:{dataset:{group:'abc'}}});
  page.handleJumpToGroup({currentTarget:{dataset:{group:-1}}});
  assert.equal(calls.scrolled.length,0);
});
