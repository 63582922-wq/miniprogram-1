const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {getInspectorName,buildReportNo}=require('../miniprogram/utils/report-identity');

/**
 * 报告编号在客户端（列表/详情）与服务端（PDF 载荷）各有一份实现。
 * 两份必须给出同样的编号，否则同一次巡查在页面上和 PDF 上会是两个号。
 * 服务端那份不在导出里，且该文件依赖 wx-server-sdk 无法直接 require，
 * 所以从源码里取出函数体在隔离上下文里执行。
 */
function loadServerBuildReportNo(){
  const source=fs.readFileSync(path.resolve(__dirname,'../cloudfunctions/report/index.js'),'utf8');
  const matched=/function buildReportNo\(report = \{\}\) \{[\s\S]*?\n\}/.exec(source);
  assert.ok(matched,'未能从 cloudfunctions/report/index.js 提取 buildReportNo');
  return vm.runInNewContext(`${matched[0]}; buildReportNo`,{Date,String,Number});
}

test("role placeholder is missing while a person's name is preserved",()=>{
 assert.equal(getInspectorName({nickname:'巡查员'}),'');
 assert.equal(getInspectorName({nickname:''}),'');
 assert.equal(getInspectorName({nickname:'陈工'}),'陈工');
});

test('report number stays the same for online list, detail and printable payload',()=>{
 const report={_id:'report-AB12',publishedAt:Date.UTC(2026,8,27)};
 assert.equal(buildReportNo(report),'CB-20260927-AB12');
});

test('the client and server report number implementations agree on every shape',()=>{
  const server=loadServerBuildReportNo();
  const cases=[
    {_id:'report-AB12',publishedAt:Date.UTC(2026,8,27)},
    {_id:'report-ab12',createdAt:Date.UTC(2026,0,1)},
    {_id:'report-ab12',generatedAt:Date.UTC(2025,11,31,23,59)},
    {_id:'report-ab12',inspectionDate:'2026-03-05T00:00:00.000Z'},
    {_id:'r',publishedAt:Date.UTC(2026,9,5)},
    {_id:'',publishedAt:Date.UTC(2026,9,5)},
    {},
    {_id:'report-ab12',publishedAt:'不是日期'},
    {_id:'report-ab12',publishedAt:0},
    {_id:'report-abcdef',publishedAt:Date.UTC(2026,11,31)}
  ];
  for(const report of cases){
    assert.equal(
      server(report),
      buildReportNo(report),
      `客户端与服务端对 ${JSON.stringify(report)} 给出了不同的报告编号`
    );
  }
});

test('the report number prefix follows the product, not the old one',()=>{
  const no=buildReportNo({_id:'report-AB12',publishedAt:Date.UTC(2026,8,27)});
  assert.match(no,/^CB-/);
  assert.doesNotMatch(no,/HLZG/,'旧前缀不应再出现在任何新生成的编号里');
});
