const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

/**
 * 问题等级曾是「界面给 4 档、系统只认 3 档」：用户选「轻微」，页面显示「轻微」，
 * 存进报告却变成「一般」——静默改写。
 *
 * 等级贯穿 AI 提示词、服务端校验与报告快照，所以这里守的不是"某一处写对了"，
 * 而是**界面提供的选项必须全部是服务端真正接受的**。
 */

const clientOptions=()=>{
  const source=read('miniprogram/constants/status.js');
  const block=source.slice(source.indexOf('const ISSUE_SEVERITY_OPTIONS'),source.indexOf('];',source.indexOf('const ISSUE_SEVERITY_OPTIONS')));
  return [...block.matchAll(/value:\s*"([a-z]+)"/g)].map(m=>m[1]);
};

const serverAccepted=()=>{
  const source=read('cloudfunctions/inspection/index.js');
  const m=source.match(/severity:\s*\[([^\]]+)\]\.includes\(item\.severity\)/);
  assert.ok(m,'服务端应当有一处明确列出接受的等级');
  return [...m[1].matchAll(/"([a-z]+)"/g)].map(x=>x[1]);
};

test('the client never offers a severity the server silently rewrites',()=>{
  const offered=clientOptions(), accepted=serverAccepted();
  assert.ok(offered.length>=3,`界面应至少有 3 档，实际 ${offered.length}`);
  const unsupported=offered.filter(v=>!accepted.includes(v));
  assert.deepEqual(unsupported,[],`这些等级界面给了、但服务端会把它们改写成别的：${unsupported.join(', ')}`);
});

test('the report knows every severity the client can produce',()=>{
  // 报告是最终交付物：认不出的等级会从统计里消失
  const acknowledged=new Set([
    ...[...read('miniprogram/pages/report/detail/index.js').matchAll(/"([a-z]+)"/g)].map(m=>m[1])
  ]);
  for(const value of clientOptions()){
    assert.ok(acknowledged.has(value),`报告页不认识等级 ${value}，它会在统计里凭空消失`);
  }
});

test('the AI is told to use exactly those severities',()=>{
  const prompt=read('cloudfunctions/ai/index.js');
  const m=prompt.match(/severity:\s*"([a-z|]+)"/);
  assert.ok(m,'AI 提示词里应写明等级取值');
  const allowed=m[1].split('|');
  assert.deepEqual([...allowed].sort(),[...clientOptions()].sort(),
    'AI 被要求输出的等级必须与界面提供的一致，否则它会产出界面表达不了的等级');
});

test('build 和 detail 用同一套访问方式标记',()=>{
  // detail 一直返回 accessMode，build 曾经没有。于是「历史记录 → 整理并生成报告」
  // 打开后 isOwner 恒为 false，页面显示成「你正在查看他人分享的巡查报告」，
  // 也没有发布/转发入口——承诺的「生成报告」什么也没生成。
  const source=read('cloudfunctions/report/index.js');
  // 切到下一个顶层定义为止；不能假定函数之间的先后顺序
  const bodyOf=(name)=>{
    const at=source.indexOf(`async function ${name}(`);
    assert.ok(at>0,`找不到 ${name}`);
    const rest=source.slice(at+10);
    const nextAt=rest.search(/\nasync function |\nfunction /);
    return rest.slice(0,nextAt>0?nextAt:rest.length);
  };
  const build=bodyOf('buildReportData');
  assert.match(build,/accessMode:/,'build 必须标明访问方式，否则客户端一律按"他人分享"渲染');
  assert.match(build,/trustedRead \? "shared" : "owner"/,'分享读者与属主要区分开');
  assert.match(bodyOf('detailReport'),/accessMode:\s*ownerCheck\.ok \? "owner" : "shared"/,'detail 原有的标记不要动');
});
