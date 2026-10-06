const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');

/**
 * 在隔离 vm 中加载真实小程序页面，注入 wx / 依赖后返回可调用的页面实例。
 *
 * 共享这一份是为了避免每个测试文件各抄一遍加载器——那种复制会让「页面行为
 * 怎么被驱动」这件事慢慢分叉。判断依据始终是页面源码本身。
 */
function loadPage(relative,dependencies={},wx={},globals={}){
  let config;
  const filename=path.resolve(__dirname,'../miniprogram/pages',relative,'index.js');
  const context={
    Page:current=>{config=current;},
    wx,console,Date,Math,JSON,Number,String,Array,Object,Boolean,Error,
    Promise,setTimeout,clearTimeout,setInterval,clearInterval,
    require:name=>{
      if(Object.prototype.hasOwnProperty.call(dependencies,name))return dependencies[name];
      return require(path.resolve(path.dirname(filename),name));
    },
    ...globals
  };
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename});
  const page={...config,data:structuredClone(config.data||{})};
  page.setData=function(patch){
    Object.entries(patch).forEach(([key,value])=>{
      if(!key.includes('.')){this.data[key]=value;return;}
      const [root,nested]=key.split('.');
      this.data[root]={...(this.data[root]||{}),[nested]:value};
    });
  };
  return {page,context};
}

/** 手动控制 resolve/reject 的 promise，用于构造并发与竞态。 */
function deferred(){
  let resolve,reject;
  const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
  return {promise,resolve,reject};
}

/** 内存版 wx storage，多个页面共享同一份即可模拟「本机草稿」。 */
function memoryStorage(initial={}){
  const store=new Map(Object.entries(initial));
  return {
    store,
    api:{
      getStorageSync:key=>store.has(key)?structuredClone(store.get(key)):'',
      setStorageSync:(key,value)=>{store.set(key,structuredClone(value));},
      removeStorageSync:key=>{store.delete(key);}
    }
  };
}

module.exports={loadPage,deferred,memoryStorage};
