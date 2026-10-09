const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const scriptPath=path.join(root,'scripts/ensure-indexes.cjs');
const docPath=path.join(root,'docs/上线后运营维护体系.md');

/**
 * 数据库没有索引是这个项目最大的规模化隐患：云开发按读取次数计费，
 * 无索引的 where 查询等于全表扫描，集合越大越慢也越贵。
 *
 * 索引清单同时存在于两处——仓库里的可执行脚本，和给运营看的文档。
 * 两处一旦漂移，就会有人照着过时的文档去建索引。这里把它们钉在一起。
 */

const loadScriptIndexes=()=>{
  const source=fs.readFileSync(scriptPath,'utf8');
  const block=source.slice(source.indexOf('const INDEXES = ['),source.indexOf('\n];',source.indexOf('const INDEXES = [')));
  const out=[];
  for(const m of block.matchAll(/collection:\s*"([^"]+)"[\s\S]*?name:\s*"([^"]+)"[\s\S]*?keys:\s*\[([\s\S]*?)\]/g)){
    const fields=[...m[3].matchAll(/name:\s*"([^"]+)"\s*,\s*direction:\s*"(-?1)"/g)]
      .map(k=>`${k[1]}${k[2]==='-1'?'↓':'↑'}`);
    out.push({collection:m[1],name:m[2],fields});
  }
  return out;
};

const loadDocIndexes=()=>{
  const doc=fs.readFileSync(docPath,'utf8');
  // 必须从「建议创建的索引」这一节往后找：文档第二节还有一张
  // 「集合 | 查询条件 | 排序」表，先匹配到它就会拿到完全错误的清单。
  const heading=doc.indexOf('### 建议创建的索引');
  assert.ok(heading>0,'文档里应有「建议创建的索引」一节');
  const start=doc.indexOf('| 集合 |',heading);
  assert.ok(start>heading,'该节下应有索引表');
  const end=doc.indexOf('\n\n',start);
  const table=doc.slice(start,end<0?undefined:end);
  const out=[];
  for(const line of table.split('\n')){
    const m=line.match(/^\|\s*`([a-z_]+)`\s*\|\s*([^|]+?)\s*\|/);
    if(!m) continue;
    // 单字段索引（users.openId、app_settings.openId）在文档里不写箭头，
    // 默认按升序——与脚本里的 direction:"1" 对齐。
    const fields=[...m[2].matchAll(/`([A-Za-z_]+)`\s*([↑↓])?/g)].map(k=>`${k[1]}${k[2]||'↑'}`);
    if(fields.length) out.push({collection:m[1],fields});
  }
  return out;
};

test('the index script and the operations doc describe the same indexes',()=>{
  const scripted=loadScriptIndexes(),documented=loadDocIndexes();
  assert.ok(scripted.length>=9,`脚本里应至少有 9 条索引，实际 ${scripted.length}`);
  assert.ok(documented.length>=9,`文档表格里应至少有 9 条索引，实际 ${documented.length}`);
  const key=(e)=>`${e.collection}:${e.fields.join('+')}`;
  const s=new Set(scripted.map(key)),d=new Set(documented.map(key));
  const onlyScript=[...s].filter(k=>!d.has(k));
  const onlyDoc=[...d].filter(k=>!s.has(k));
  assert.deepEqual(onlyScript,[],`只在脚本里、文档漏了：\n  ${onlyScript.join('\n  ')}`);
  assert.deepEqual(onlyDoc,[],`只在文档里、脚本漏了：\n  ${onlyDoc.join('\n  ')}`);
});

test('the index script never carries a credential of its own',()=>{
  const source=fs.readFileSync(scriptPath,'utf8');
  assert.match(source,/process\.env\.WX_APPSECRET/,'密钥只能从环境变量读');
  // 任何看起来像真密钥的赋值都不允许
  const suspicious=[...source.matchAll(/(?:appsecret|secret|token|key)\s*[:=]\s*["']([A-Za-z0-9]{16,})["']/gi)]
    .map(m=>m[1]).filter(v=>!/^(APPID|ENV_ID|APPSECRET|index|token|name|direction)$/.test(v));
  assert.deepEqual(suspicious,[],`脚本里不应出现字面量密钥：${suspicious.join(', ')}`);
  assert.doesNotMatch(source,/console\.log\([^)]*APPSECRET/,'密钥不得被打印');
});

test('the two unique indexes stay unique — the code reads exactly one row per openId',()=>{
  const scripted=loadScriptIndexes();
  for(const collection of ['users','app_settings']){
    const entry=scripted.find(e=>e.collection===collection);
    assert.ok(entry,`${collection} 必须有索引（代码按 openId 取最新一条）`);
    const source=fs.readFileSync(scriptPath,'utf8');
    const block=source.slice(source.indexOf(`collection: "${collection}"`));
    assert.match(block.slice(0,400),/unique:\s*true/,`${collection}.openId 应为唯一索引`);
  }
});
