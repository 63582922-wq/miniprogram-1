const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

/**
 * 内测期间「我装的是哪一版」必须一眼可见——体验版、开发版、正式版的代码
 * 可能差着十几个版本，测试者反馈时说不清版本，排查就只能靠猜。
 */

const load=(wx,stamped={})=>{
  const module={exports:{}};
  // 每个用例都重新求值：模块内对 build-info 做了缓存
  vm.runInNewContext(read('miniprogram/utils/app-version.js'),{
    module,require:(id)=>(id.includes('build-info')?stamped:{}),wx
  });
  return module.exports;
};
const withAccount=(envVersion,version)=>({getAccountInfoSync:()=>({miniProgram:{envVersion,version}})});
const textOf=(wx)=>load(wx).getBuildInfo().text;

test('each build channel is named the way testers say it',()=>{
  assert.equal(textOf(withAccount('trial','1.0.26')),'体验版 1.0.26');
  assert.equal(textOf(withAccount('release','1.0.26')),'正式版 1.0.26');
  assert.equal(textOf(withAccount('develop','1.0.26')),'开发版 1.0.26');
});

test('local preview shows nothing rather than a half sentence',()=>{
  // IDE 直接编译时没有环境标识也没有版本号，不能渲染出「版本 」这种半截文案
  assert.equal(textOf(withAccount('','')),'');
  assert.equal(textOf(withAccount(undefined,undefined)),'');
  // 有渠道没版本号：只报渠道，不拼空版本
  assert.equal(textOf(withAccount('trial','')),'体验版');
});

test('a client without getAccountInfoSync never breaks the page',()=>{
  assert.doesNotThrow(()=>load({}).getBuildInfo());
  assert.equal(load({}).getBuildInfo().text,'');
  const throwing={getAccountInfoSync:()=>{throw new Error('not supported');}};
  assert.doesNotThrow(()=>load(throwing).getBuildInfo());
  assert.equal(load(throwing).getBuildInfo().text,'');
});

test('the profile page actually surfaces the build',()=>{
  const script=read('miniprogram/pages/profile/index.js');
  const markup=read('miniprogram/pages/profile/index.wxml');
  assert.match(script,/getBuildInfo\(\)/,'「我的」要读取当前版本');
  assert.match(script,/buildText:getBuildInfo\(\)\.text/,'版本要真的写进 data');
  assert.match(markup,/wx:if="\{\{buildText\}\}"/,'没有版本号时不要留空行');
  assert.match(markup,/\{\{buildText\}\}/,'版本要渲染出来');
});

test('开发版 falls back to the version stamped at upload time',()=>{
  // 微信只在体验版/正式版下发版本号，开发版的 version 是空的。
  // 不回退的话，界面上只剩一个光秃秃的「开发版」——正是这次踩到的坑。
  const wx=withAccount('develop','');
  assert.equal(load(wx,{version:'1.0.27'}).getBuildInfo().text,'开发版 1.0.27');
  assert.equal(load(wx,{version:'1.0.27'}).getBuildInfo().source,'stamped');
});

test('the platform version wins when the platform actually gives one',()=>{
  const info=load(withAccount('trial','1.0.99'),{version:'1.0.27'}).getBuildInfo();
  assert.equal(info.text,'体验版 1.0.99');
  assert.equal(info.source,'platform','体验版要相信自己拿到的版本号，而不是本地那份');
});

test('no stamp and no platform version still yields a clean label',()=>{
  assert.equal(load(withAccount('develop',''),{}).getBuildInfo().text,'开发版');
  assert.equal(load(withAccount('develop',''),{}).getBuildInfo().source,'');
});
