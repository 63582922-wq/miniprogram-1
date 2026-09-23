const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness(){
 const tables=new Map();let owner='owner', fail=null;
 const table=n=>{if(!tables.has(n))tables.set(n,new Map());return tables.get(n)};
 const matches=(row,q)=>typeof q==='function'?q(row):Object.entries(q||{}).every(([k,v])=>typeof v==='function'?v(row[k]):row[k]===v);
 const command={in:xs=>v=>xs.includes(v),lte:n=>v=>v<=n,neq:n=>v=>v!==n,exists:b=>v=>(v!==undefined)===b,and:qs=>r=>qs.every(q=>matches(r,q)),or:qs=>r=>qs.some(q=>matches(r,q)),remove:()=>undefined};
 const db={command,collection(n){const t=table(n);const q=(filter={},offset=0,limit=100,sort=null)=>({
   where:f=>q(f,offset,limit,sort),skip:s=>q(filter,s,limit,sort),limit:l=>q(filter,offset,l,sort),orderBy:(k,d)=>q(filter,offset,limit,[k,d]),
   get:async()=>{let rows=[...t.values()].filter(r=>matches(r,filter));if(sort)rows.sort((a,b)=>(a[sort[0]]>b[sort[0]]?1:-1)*(sort[1]==='desc'?-1:1));return {data:structuredClone(rows.slice(offset,offset+limit))}},
   count:async()=>({total:[...t.values()].filter(r=>matches(r,filter)).length}),
   update:async({data})=>{let updated=0;for(const [id,row]of t){if(matches(row,filter)){t.set(id,{...row,...structuredClone(data)});updated++}}return {stats:{updated}}},
   add:async({data})=>{const id=data._id||'auto-'+t.size;if(t.has(id))throw Error('duplicate');t.set(id,structuredClone({...data,_id:id}));return {_id:id}},
   doc:id=>({get:async()=>{if(!t.has(id))throw Error('missing');return {data:structuredClone(t.get(id))}},set:async({data})=>{if(fail&&fail(n,id))throw Error('injected failure');t.set(id,structuredClone({...data,_id:id}));return {}},update:async({data})=>{if(!t.has(id))throw Error('missing');t.set(id,{...t.get(id),...structuredClone(data)});return {}},remove:async()=>{t.delete(id);return {}}})
 });return q();}};
 const cloud={init(){},DYNAMIC_CURRENT_ENV:'test',database:()=>db,getWXContext:()=>({OPENID:owner}),getTempFileURL:async({fileList})=>({fileList:fileList.map(fileID=>({fileID,tempFileURL:'https://example.com/'+encodeURIComponent(fileID)}))})};
 function load(name,options={}){const filename=path.resolve(__dirname,'../cloudfunctions/'+name+'/index.js');const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{require:n=>n==='wx-server-sdk'?cloud:options.modules?.[n]|| (n.startsWith('.')?require(path.resolve(path.dirname(filename),n)):require(n)),exports:module.exports,module,console:options.console||console,process:{env:options.env||{}},Buffer,URL,setTimeout,clearTimeout,Date},{filename});return module.exports.main;}
 return {load,table,as:v=>owner=v,failWhen:f=>fail=f,db};
}
module.exports={harness};
