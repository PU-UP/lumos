'use strict';
const $=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
const url=new URL(location.href),focusId=url.searchParams.get('episode');
let token='',data=null,limit=50,pending=null,loading=false,read=0;
$('workspace').value=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';
const statusNames={pending:'等待处理',running:'处理中',failed:'执行失败',done:'已保存',needs_review:'有待确认项',obsolete:'来源已变化',proposed:'候选已返回',interrupted:'执行中断'};
function feedback(id){const a=el('a','向仓库维护者反馈');a.href='/chat?workspace='+$('workspace').value+'&agent=maintainer&episode='+encodeURIComponent(id);return a;}
function render(){
  if(!data)return;
  $('findings').replaceChildren();
  for(const f of data.findings){const d=el('details');d.append(el('summary',f.title),el('p',f.suggestion),feedback(f.episode_id));$('findings').append(d);}
  if(!data.findings.length)$('findings').append(el('p','当前没有失败、过期或失效的执行记录。'));
  const selected=$('role-filter').value,rows=data.episodes.filter(n=>(!focusId||n.id===focusId)&&(!selected||n.agent_role===selected||n.agent_steps?.some(s=>s.role===selected)));
  $('episodes').replaceChildren();
  for(const item of rows.slice(0,limit)){
    const d=el('details');d.open=item.id===focusId;
    d.append(el('summary',item.title+' · '+(statusNames[item.status]||item.status)),el('p',item.created_at+' · '+(data.roles[item.agent_role]?.name||'历史角色未记录')));
    if(item.summary)d.append(el('p',item.summary));if(item.error)d.append(el('p',item.error));
    if(item.agent_steps?.length){const list=el('ol');for(const s of item.agent_steps){const li=el('li',(data.roles[s.role]?.name||s.role)+' · '+(statusNames[s.status]||s.status)+' · 第 '+s.attempt+' 次');li.append(el('p',s.summary||s.error||'执行尚未返回'));const meta=el('details');meta.append(el('summary','执行依据'),el('p',[s.started_at,s.finished_at||'',s.model,'步骤 '+s.id,'输入版本 '+s.basis,'规则版本 '+s.rules_hash,'代码版本 '+s.code_hash].join('\n')));li.append(meta);list.append(li);}d.append(list);}
    else d.append(el('p','外部整理或历史记录，未记录内部步骤。'));
    if(item.episode_ref){const a=el('a','查看反馈所指的执行');a.href='/agents?workspace='+$('workspace').value+'&episode='+encodeURIComponent(item.episode_ref);d.append(a);}
    if(item.chat_id||item.note){const a=el('a','查看原始输入');a.href=item.chat_id?'/chat?workspace='+$('workspace').value+'&id='+item.chat_id:'/notes?note='+encodeURIComponent(item.note.id);d.append(a);}
    d.append(feedback(item.id));$('episodes').append(d);
  }
  $('more').hidden=rows.length<=limit;
  $('status').textContent=rows.length?'共 '+rows.length+' 条；候选返回不代表保存成功，请以每轮最终状态为准。':'没有符合条件的执行记录。';
}
async function load(){const generation=++read;loading=true;$('inspect').disabled=true;try{const r=await fetch('/api/agents?workspace='+$('workspace').value),value=await r.json();if(generation!==read)return;if(!r.ok)throw new Error(value.error||'读取失败');data=value;token=data.token;$('roles').replaceChildren();if($('role-filter').options.length===1)for(const [id,role] of Object.entries(data.roles)){const o=el('option',role.name);o.value=id;$('role-filter').append(o);}for(const [id,role] of Object.entries(data.roles)){const div=el('div'),a=el('a','直接对话');a.href='/chat?workspace='+$('workspace').value+'&agent='+id;div.append(el('strong',role.name),el('p',role.purpose),a);$('roles').append(div);}render();}catch(e){$('status').textContent='读取失败：'+e.message;}finally{if(generation===read){loading=false;$('inspect').disabled=false;}}}
$('workspace').onchange=()=>{limit=50;load();};$('role-filter').onchange=render;$('more').onclick=()=>{limit+=50;render();};
$('inspect').onclick=async()=>{if(loading)return;loading=true;$('inspect').disabled=true;$('workspace').disabled=true;pending||={request_id:crypto.randomUUID().replaceAll('-',''),workspace:$('workspace').value};try{const r=await fetch('/api/agent-inspect',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),value=await r.json();if(!r.ok){if(r.status>=400&&r.status<500)pending=null;throw new Error(value.error||'巡检失败');}pending=null;await load();}catch(e){$('status').textContent=e.message+'；可点击重试巡检。';}finally{loading=false;$('inspect').disabled=false;$('workspace').disabled=!!pending;$('inspect').textContent=pending?'重试确认巡检':'运行只读巡检';}};
load();
