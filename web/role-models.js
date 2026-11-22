'use strict';
// Browser values bootstrap missing preferences; the data root owns saved selections.
const roleModelKey=role=>'lumos.chat.model.'+role;
function selectedRoleModel(role,storage=localStorage){try{return storage.getItem(roleModelKey(role))??storage.getItem('lumos.chat.model')??'';}catch{return '';}}
function receiptModel(data){
  const recorded=[...new Set((data.agent_steps||[]).map(s=>s.model).filter(m=>m&&m!=='none'))];
  if(recorded.length)return recorded.map(m=>m==='executor-default'?'默认模型（具体型号未记录）':m).join(' / ');
  if(data.agent_steps?.length)return '未调用模型';
  return data.model||'默认模型（具体型号未记录）';
}
if(typeof module!=='undefined')module.exports={selectedRoleModel,receiptModel};
function modelPreferences(fetcher,storage,notify){
  let selected={},token='',queue=Promise.resolve(),pending=0,refresh=null;
  const api={get:role=>selected[role]??selectedRoleModel(role,storage),receipt:receiptModel,error:'',loading:true,busy:false};
  function accept(data){
    const changed=JSON.stringify(selected)!==JSON.stringify(data.models)||!!api.error;
    selected=data.models;if(data.token)token=data.token;
    for(const [role,model] of Object.entries(selected))try{storage.setItem(roleModelKey(role),model);}catch{}
    api.error='';if(changed)notify();
  }
  async function read(){const r=await fetcher('/api/role-models'),d=await r.json();if(!r.ok)throw Error(d.error||'模型设置读取失败');accept(d);}
  async function write(changes,expected=Object.fromEntries(Object.keys(changes).map(r=>[r,selected[r]??null]))){
    const r=await fetcher('/api/role-models',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify({models:changes,expected})}),d=await r.json();
    if(!r.ok)throw Error(d.error||'模型设置保存失败');accept(d);
  }
  api.reload=()=>{
    if(refresh)return refresh;
    refresh=queue.then(async()=>{await api.ready;try{await read();}catch(e){if(api.error!==e.message){api.error=e.message;notify();}}}).finally(()=>{refresh=null;});
    queue=refresh.catch(()=>{});return refresh;
  };
  api.ready=(async()=>{
    try{
      await read();const missing={};
      for(const role of ['lumos','aipm','librarian','maintainer'])if(!(role in selected)){
        let value=null;try{value=storage.getItem(roleModelKey(role))??storage.getItem('lumos.chat.model');}catch{}
        if(value!==null&&value!==undefined)missing[role]=value;
      }
      if(Object.keys(missing).length)try{await write(missing);}catch(e){await read();if(Object.keys(missing).some(r=>!(r in selected)))throw e;}
    }catch(e){api.error=e.message;}finally{api.loading=false;notify();}
  })();
  api.save=(role,model)=>{
    const expected=api.loading?undefined:{[role]:selected[role]??null};
    pending++;api.busy=true;notify();
    const task=queue.then(async()=>{await api.ready;try{await write({[role]:model},expected);}catch(e){try{await read();}catch{}api.error=e.message;throw e;}})
      .finally(()=>{api.busy=--pending>0;notify();});
    queue=task.catch(()=>{});
    return task;
  };
  return api;
}
if(typeof module!=='undefined')module.exports.modelPreferences=modelPreferences;
if(typeof window!=='undefined'){
  window.LumosModels=modelPreferences((...args)=>fetch(...args),localStorage,()=>window.dispatchEvent(new CustomEvent('lumos-model')));
  window.addEventListener('storage',e=>{if(e.key?.startsWith('lumos.chat.model'))window.LumosModels.reload();});
  window.addEventListener('focus',()=>window.LumosModels.reload());
}
