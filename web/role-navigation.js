'use strict';
const roleSpaces={
  lumos:{name:'Lumos',purpose:'看重点，协调下一步',home:'/',links:[]},
  aipm:{name:'AIPM',purpose:'推进项目与任务',home:'/tasks',links:[]},
  librarian:{name:'Atlas',purpose:'整理笔记与资料',home:'/knowledge',links:[]},
  maintainer:{name:'Ops',purpose:'检查运行，处理异常',home:'/agents',links:[]}
};
function pageRole(url){return roleSpaces[url.searchParams.get('role')]?url.searchParams.get('role'):
  roleSpaces[url.searchParams.get('agent')]?url.searchParams.get('agent'):
  ['/tasks','/people'].includes(url.pathname)?'aipm':['/notes','/knowledge'].includes(url.pathname)?'librarian':url.pathname==='/agents'?'maintainer':'lumos';}
if(typeof module!=='undefined')module.exports={roleSpaces,pageRole};
if(typeof document!=='undefined'){
  const url=new URL(location.href),role=pageRole(url),info=roleSpaces[role],space=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';
  const embedded=url.pathname==='/chat'&&url.searchParams.get('embedded')==='1';
  if(embedded)document.body.classList.add('embedded-chat');
  url.searchParams.set('workspace',space);history.replaceState(null,'',url);
  const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
  const target=(path,r)=>{const u=new URL(path,location.href);u.searchParams.set('role',r);u.searchParams.set('workspace',space);return u.pathname+u.search;};
  const nav=document.querySelector('.view-nav');nav.replaceChildren();nav.setAttribute('aria-label','四个助手');
  for(const [id,r] of Object.entries(roleSpaces)){const a=el('a');a.href=target(r.home,id);a.append(el('strong',r.name),el('small',r.purpose));if(id===role)a.setAttribute('aria-current','page');nav.append(a);}
  const local=el('nav');local.className='role-tools';local.setAttribute('aria-label',info.name+'工作区');
  for(const [name,path] of info.links){const a=el('a',name);a.href=target(path,role);const u=new URL(a.href,location.href);if(u.pathname===url.pathname&&u.searchParams.get('materials')===url.searchParams.get('materials')&&u.searchParams.get('view')===url.searchParams.get('view'))a.setAttribute('aria-current','page');local.append(a);}
  nav.after(local);
  const modelChoice=el('label','对话与答复模型'),modelSelect=el('select'),modelMessage=el('span');
  modelChoice.className='role-model-choice';modelSelect.setAttribute('aria-label',info.name+' 当前模型');modelMessage.setAttribute('role','status');modelMessage.className='model-message';
  modelChoice.append(modelSelect);local.prepend(modelChoice);local.append(modelMessage);
  let modelOptions=[];
  const updateModels=()=>{
    modelSelect.disabled=window.LumosModels.loading||window.LumosModels.busy;
    modelMessage.textContent=window.LumosModels.error||(window.LumosModels.busy?'正在保存模型…':'');
    const selected=window.LumosModels.get(displayedRole||role),options=[{id:'',name:'Codex 默认'},...modelOptions];
    if(selected&&!options.some(m=>m.id===selected))options.push({id:selected,name:selected});
    modelSelect.replaceChildren();for(const m of options){const o=el('option',m.name);o.value=m.id;modelSelect.append(o);}modelSelect.value=selected;
    for(const a of nav.querySelectorAll('a')){const id=new URL(a.href,location.href).searchParams.get('role'),value=window.LumosModels.get(id);let badge=a.querySelector('.role-model-name');if(!badge){badge=el('span');badge.className='role-model-name';a.append(badge);}badge.textContent=modelOptions.find(m=>m.id===value)?.name||value||'Codex 默认';badge.title=value||'使用本机 Codex 默认配置；历史未记录的具体型号不会推测。';}
  };
  modelSelect.onchange=async()=>{try{await window.LumosModels.save(displayedRole||role,modelSelect.value);}catch{updateModels();}};
  window.addEventListener('storage',updateModels);window.addEventListener('lumos-model',updateModels);
  document.body.classList.add('simple-workspace');
  if(url.pathname!==info.home||url.searchParams.has('view')){const back=el('a','返回 '+info.name);back.href=target(info.home,role);local.append(back);}
  const picker=document.querySelector('#workspace, #note-workspace, #chat-workspace');
  const scopeCaption=el('span','资料范围：'+(space==='lumos'?'Lumos 仓库维护':'灵光'));scopeCaption.className='role-scope-text';
  if(picker){picker.value=space;picker.closest('label').hidden=true;if(url.pathname!=='/chat'&&!window.LumosUnified)local.append(scopeCaption);}
  window.addEventListener('lumos-scope',e=>{if(!['lingguang','lumos'].includes(e.detail))return;picker.value=e.detail;scopeCaption.textContent='资料范围：'+(e.detail==='lumos'?'Lumos 仓库维护':'灵光');const current=new URL(location.href);current.searchParams.set('workspace',e.detail);history.replaceState(null,'',current);for(const a of document.querySelectorAll('.view-nav a,.role-tools a')){const u=new URL(a.href,location.href);u.searchParams.set('workspace',e.detail);a.href=u.pathname+u.search;}});
  const header=document.querySelector('header');
  for(const n of document.querySelectorAll('.section-links'))n.hidden=true;
  const divider=header.querySelector('.divider');if(divider){divider.nextElementSibling?.remove();divider.remove();}
  const description=el('span');description.className='role-purpose';header.append(description);
  const workerAlert=el('p');workerAlert.className='worker-alert';workerAlert.setAttribute('role','status');workerAlert.hidden=true;
  if(!embedded)header.after(workerAlert);
  let previewShown=false;
  async function checkWorker(){
    try{const r=await fetch('/api/health');if(!r.ok)throw Error();const d=await r.json();
      if(d.preview&&!previewShown){const p=el('p','体验版 · 使用模拟数据，与正式工作记录隔离');p.className='preview-banner';header.before(p);previewShown=true;}
      const status=d.worker?.state;
      workerAlert.textContent=status==='stopped'?'后台处理已停止，需重启本机服务；已保存的输入仍保留。':status==='waiting'?(d.worker.error||'后台处理暂停，正在等待恢复；已保存的输入仍保留。'):status==='offline'?'Codex 执行器未运行；已保存的输入会在恢复后接续。':'';
    }catch{workerAlert.textContent='暂时无法连接后台，请检查本机服务；未发送内容请保留。';}
    workerAlert.hidden=!workerAlert.textContent;if(!embedded)setTimeout(checkWorker,5000);
    if(!embedded&&!window.LumosModels.loading&&!window.LumosModels.busy)window.LumosModels.reload();
  }
  checkWorker();
  picker?.addEventListener('change',()=>{for(const a of document.querySelectorAll('.view-nav a,.role-tools a')){const u=new URL(a.href,location.href);u.searchParams.set('workspace',picker.value);a.href=u.pathname+u.search;}});
  let displayedRole=role,displayedSpace=space;
  updateModels();fetch('/api/codex-models').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(d=>{modelOptions=d.models;updateModels();}).catch(()=>{modelMessage.textContent='模型列表暂不可用，保留已选模型。';});
  window.addEventListener('lumos-role',e=>{
    const bound=roleSpaces[e.detail];if(!bound)return;
    const currentSpace=new URL(location.href).searchParams.get('workspace')||'lingguang';
    if(displayedRole===e.detail&&displayedSpace===currentSpace)return;
    displayedRole=e.detail;displayedSpace=currentSpace;
    for(const a of nav.querySelectorAll('a')){const u=new URL(a.href,location.href);a.setAttribute('aria-current',u.searchParams.get('role')===e.detail?'page':'false');u.searchParams.set('workspace',currentSpace);a.href=u.pathname+u.search;}
    description.textContent=bound.purpose;local.setAttribute('aria-label',bound.name+'工作区');local.replaceChildren();
    modelSelect.setAttribute('aria-label',bound.name+' 当前模型');local.append(modelChoice,modelMessage);updateModels();
    for(const [name,path] of bound.links){const a=el('a',name);const u=new URL(target(path,e.detail),location.href);u.searchParams.set('workspace',new URL(location.href).searchParams.get('workspace')||'lingguang');a.href=u.pathname+u.search;if(u.pathname===url.pathname)a.setAttribute('aria-current','page');local.append(a);}
  });
}
