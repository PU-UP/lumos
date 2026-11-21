'use strict';
const roleSpaces={
  lumos:{name:'Lumos',purpose:'看全局、理清目标、协调下一步',home:'/',links:[['工作概览','/'],['工作回报','/agents'],['对话','/chat']]},
  aipm:{name:'AIPM',purpose:'核对项目、建议安排、接续关键问题',home:'/tasks',links:[['任务','/tasks'],['人员','/people'],['阶段交付','/?view=delivery'],['对话','/chat']]},
  librarian:{name:'Atlas',purpose:'资料管理员 · 笔记、项目文件与知识来源',home:'/notes',links:[['笔记','/notes'],['资料查找','/knowledge'],['项目资料','/knowledge?materials=1'],['对话','/chat']]},
  maintainer:{name:'Ops',purpose:'系统监控 · 直接向王牧楠汇报',home:'/agents',links:[['运行报告','/agents'],['对话','/chat']]}
};
function pageRole(url){return roleSpaces[url.searchParams.get('role')]?url.searchParams.get('role'):
  roleSpaces[url.searchParams.get('agent')]?url.searchParams.get('agent'):
  ['/tasks','/people'].includes(url.pathname)?'aipm':['/notes','/knowledge'].includes(url.pathname)?'librarian':url.pathname==='/agents'?'maintainer':'lumos';}
if(typeof module!=='undefined')module.exports={roleSpaces,pageRole};
if(typeof document!=='undefined'){
  const url=new URL(location.href),role=pageRole(url),info=roleSpaces[role],space=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';
  const el=(tag,text)=>{const e=document.createElement(tag);if(text)e.textContent=text;return e;};
  const target=(path,r)=>{const u=new URL(path,location.href);u.searchParams.set('role',r);u.searchParams.set('workspace',space);return u.pathname+u.search;};
  const nav=document.querySelector('.view-nav');nav.replaceChildren();nav.setAttribute('aria-label','四个助手');
  for(const [id,r] of Object.entries(roleSpaces)){const a=el('a');a.href=target(url.pathname==='/chat'?'/chat':r.home,id);a.append(el('strong',r.name),el('small',r.purpose));if(id===role)a.setAttribute('aria-current','page');nav.append(a);}
  const local=el('nav');local.className='role-tools';local.setAttribute('aria-label',info.name+'工作区');
  for(const [name,path] of info.links){const a=el('a',name);a.href=target(path,role);const u=new URL(a.href,location.href);if(u.pathname===url.pathname&&u.searchParams.get('materials')===url.searchParams.get('materials')&&u.searchParams.get('view')===url.searchParams.get('view'))a.setAttribute('aria-current','page');local.append(a);}
  nav.after(local);
  const picker=document.querySelector('#workspace, #note-workspace, #chat-workspace');
  if(picker){picker.value=space;const label=picker.closest('label');if(url.pathname==='/chat')label.hidden=true;else{label.classList.add('role-scope');local.append(label);}}
  const header=document.querySelector('header');
  for(const n of document.querySelectorAll('.section-links'))n.hidden=true;
  const divider=header.querySelector('.divider');if(divider){divider.nextElementSibling?.remove();divider.remove();}
  const description=el('span',info.purpose);description.className='role-purpose';header.append(description);
  fetch('/api/health').then(r=>r.json()).then(d=>{if(d.preview){const p=el('p','体验版 · 使用模拟数据，与正式工作记录隔离');p.className='preview-banner';header.before(p);}}).catch(()=>{});
  picker?.addEventListener('change',()=>{for(const a of document.querySelectorAll('.view-nav a,.role-tools a')){const u=new URL(a.href,location.href);u.searchParams.set('workspace',picker.value);a.href=u.pathname+u.search;}});
  let displayedRole=role,displayedSpace=space;
  window.addEventListener('lumos-role',e=>{
    const bound=roleSpaces[e.detail];if(!bound)return;
    const currentSpace=new URL(location.href).searchParams.get('workspace')||'lingguang';
    if(displayedRole===e.detail&&displayedSpace===currentSpace)return;
    displayedRole=e.detail;displayedSpace=currentSpace;
    for(const a of nav.querySelectorAll('a')){const u=new URL(a.href,location.href);a.setAttribute('aria-current',u.searchParams.get('role')===e.detail?'page':'false');u.searchParams.set('workspace',currentSpace);a.href=u.pathname+u.search;}
    description.textContent=bound.purpose;local.setAttribute('aria-label',bound.name+'工作区');local.replaceChildren();
    for(const [name,path] of bound.links){const a=el('a',name);const u=new URL(target(path,e.detail),location.href);u.searchParams.set('workspace',new URL(location.href).searchParams.get('workspace')||'lingguang');a.href=u.pathname+u.search;if(u.pathname===url.pathname)a.setAttribute('aria-current','page');local.append(a);}
  });
}
