'use strict';
function findingGroups(findings){
  return ['failed','expired'].map(code=>({code,items:findings.filter(f=>f.code===code)})).filter(g=>g.items.length);
}
if(typeof module!=='undefined')module.exports={findingGroups};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  const url=new URL(location.href);
  let focusId=url.searchParams.get('episode'),token='',data=null,limit=20,pending=null,loading=false,read=0;
  $('workspace').value=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';
  const names={pending:'等待处理',running:'处理中',failed:'执行失败',done:'已保存',needs_review:'有待确认项',obsolete:'旧结果未应用',proposed:'候选已返回',interrupted:'执行中断'};
  const date=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  function feedback(id){const a=el('a','请维护者查看');a.href='/chat?workspace='+$('workspace').value+'&agent=maintainer&episode='+encodeURIComponent(id);return a;}
  function focusEpisode(id){focusId=id;const u=new URL(location.href);if(id)u.searchParams.set('episode',id);else u.searchParams.delete('episode');history.replaceState(null,'',u);}
  function openHistory(id){focusEpisode(id);$('role-filter').value='';$('result-filter').value='';$('history-panel').open=true;renderHistory();$('history-panel').scrollIntoView({block:'start'});}
  function renderHistory(){
    if(!data)return;
    const role=$('role-filter').value,status=$('result-filter').value;
    const rows=data.episodes.filter(n=>(!focusId||n.id===focusId)&&(!role||n.agent_role===role||n.agent_steps?.some(s=>s.role===role))&&(!status||n.status===status));
    $('episodes').replaceChildren();
    if(focusId){const all=el('button','返回全部历史');all.onclick=()=>{focusEpisode(null);renderHistory();};$('episodes').append(all);}
    for(const item of rows.slice(0,limit)){
      const d=el('details');d.open=item.id===focusId;
      d.append(el('summary',item.title+' · '+(names[item.status]||item.status)),el('p',date(item.created_at)+' · '+(data.roles[item.agent_role]?.name||'历史角色未记录')));
      if(item.summary)d.append(el('p',item.summary));if(item.error)d.append(el('p',item.error));
      if(item.agent_steps?.length){const list=el('ol');for(const s of item.agent_steps){const li=el('li',(data.roles[s.role]?.name||s.role)+' · '+(names[s.status]||s.status)+' · 第 '+s.attempt+' 次');li.append(el('p',s.summary||s.error||'尚未返回'));const meta=el('details');meta.append(el('summary','技术信息'),el('p',[s.started_at,s.finished_at||'',s.model,'步骤 '+s.id,'输入版本 '+s.basis,'规则版本 '+s.rules_hash,'代码版本 '+s.code_hash].join('\n')));li.append(meta);list.append(li);}d.append(list);}
      else d.append(el('p','外部整理或历史记录，未记录内部步骤。'));
      if(item.episode_ref){const a=el('a','反馈所指的处理');a.href='/agents?workspace='+$('workspace').value+'&episode='+encodeURIComponent(item.episode_ref);d.append(a);}
      if(item.chat_id||item.note){const a=el('a','打开原始内容');a.href=item.chat_id?'/chat?workspace='+$('workspace').value+'&id='+item.chat_id:'/notes?workspace='+$('workspace').value+'&id='+encodeURIComponent(item.note.id);d.append(a);}
      d.append(feedback(item.id));$('episodes').append(d);
    }
    $('more').hidden=rows.length<=limit;$('status').textContent=rows.length?'共 '+rows.length+' 条。候选返回不代表保存成功，以本轮最终结果为准。':'没有符合条件的记录。';
  }
  function render(){
    const count=data.findings.filter(f=>f.code!=='obsolete').length;
    $('runtime-title').textContent=count?count+' 项处理需要接续':'当前没有需要接续的处理异常';
    $('runtime-summary').textContent=(data.running?'正在处理 '+data.running+' 项。':'')+(data.pending?'等待处理 '+data.pending+' 项。':'')+(data.executor==='offline'?'后台执行器未运行，已保存的输入仍保留。':'')+(count?'以下只列当前输入仍有效的处理问题。':'历史失败和已替代的旧结果可在下方追溯。');
    $('findings').replaceChildren();
    for(const group of findingGroups(data.findings)){
      const section=el('div');section.className='finding-group';
      section.append(el('h3',group.code==='failed'?'未完成的处理 · '+group.items.length:'执行中断，需要接续 · '+group.items.length));
      const more=el('details');more.append(el('summary','其余 '+Math.max(0,group.items.length-3)+' 项'));
      group.items.forEach((f,index)=>{const row=el('div');row.className='finding-row';const info=el('div');info.append(el('strong',f.subject||'待接续内容'),el('p',date(f.at)+' · 原输入已保留'));const actions=el('div');const b=el('button','查看经过');b.onclick=()=>openHistory(f.episode_id);actions.append(b,feedback(f.episode_id));row.append(info,actions);(index<3?section:more).append(row);});
      if(group.items.length>3)section.append(more);$('findings').append(section);
    }
    $('history-title').textContent='查看处理历史'+(data.history_count?' · '+data.history_count+' 项旧结果不再影响当前处理':'');
    if(focusId)$('history-panel').open=true;
    if($('history-panel').open)renderHistory();
  }
  async function load(){const generation=++read;loading=true;$('inspect').disabled=true;try{const r=await fetch('/api/agents?workspace='+$('workspace').value),value=await r.json();if(generation!==read)return;if(!r.ok)throw new Error(value.error||'读取失败');data=value;token=data.token;$('inspect').textContent=pending?'重试确认检查':'检查一次';$('roles').replaceChildren();if($('role-filter').options.length===1)for(const [id,role] of Object.entries(data.roles)){const o=el('option',role.name);o.value=id;$('role-filter').append(o);}for(const [id,role] of Object.entries(data.roles)){const div=el('div'),a=el('a','直接对话');a.href='/chat?workspace='+$('workspace').value+'&agent='+id;div.append(el('strong',role.name),el('p',role.purpose),a);$('roles').append(div);}render();}catch(e){if(generation!==read)return;token='';$('runtime-title').textContent='暂时无法读取运行情况';$('runtime-summary').textContent=e.message+'；点击“重新读取”重试。';$('inspect').textContent='重新读取';}finally{if(generation===read){loading=false;$('inspect').disabled=false;}}}
  $('workspace').onchange=()=>{limit=20;focusEpisode(null);data=null;$('findings').replaceChildren();$('episodes').replaceChildren();load();};$('role-filter').onchange=()=>{focusEpisode(null);renderHistory();};$('result-filter').onchange=()=>{focusEpisode(null);renderHistory();};$('more').onclick=()=>{limit+=20;renderHistory();};$('history-panel').ontoggle=()=>{if($('history-panel').open)renderHistory();};
  $('inspect').onclick=async()=>{if(loading)return;if(!token){await load();return;}loading=true;$('inspect').disabled=true;$('workspace').disabled=true;pending||={request_id:crypto.randomUUID().replaceAll('-',''),workspace:$('workspace').value};try{const r=await fetch('/api/agent-inspect',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),value=await r.json();if(!r.ok){if(r.status>=400&&r.status<500)pending=null;throw new Error(value.error||'检查失败');}pending=null;await load();}catch(e){$('runtime-summary').textContent=e.message+'；可点击重试检查。';}finally{loading=false;$('inspect').disabled=false;$('workspace').disabled=!!pending;$('inspect').textContent=pending?'重试确认检查':'检查一次';}};
  load();
}
