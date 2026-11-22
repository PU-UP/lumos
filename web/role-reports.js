'use strict';
function reportItems(data,role,history=false){
  return history?(data.episodes||[]):(role==='lumos'?data.lumos_reports||[]:data.issues||data.ops_reports||[]);
}
function reportLabel(item,role,history=false){
  if(item.outcome==='obsolete')return '原内容已变化 · 未应用';
  if(history)return {pending:'等待处理',running:'处理中',failed:'未完成',done:'已保存',needs_review:'需要补充',obsolete:'来源已变化'}[item.status]||item.status;
  if(role==='lumos')return item.status==='processing'?(item.outcome==='failed'?'处理受阻 · 已报 Ops':'已接收 · 正在处理'):item.decision?.phase==='external'?'Lumos 外部协调 · 已保存':item.decision?'Lumos 已决策 · 已保存':'已同步 Lumos';
  return {pending:'Ops 已收到 · 待诊断',detected:'检测到异常 · 待诊断',diagnosed:'已给出诊断 · 未确认修复',recovered:'原处理已接续',rechecked:'复查未再发现此异常'}[item.status]||item.status;
}
if(typeof module!=='undefined')module.exports={reportItems,reportLabel};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const url=new URL(location.href),role=url.searchParams.get('role')==='lumos'?'lumos':'maintainer';
  const names={lumos:'Lumos',aipm:'AIPM',librarian:'Atlas',maintainer:'Ops'};
  let data=null,token='',history=false,limit=20,generation=0,pending=null,busy=false;
  $('workspace').value=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';
  $('reports-title').textContent=role==='lumos'?'处理记录':'运行状态';
  document.title=$('reports-title').textContent;
  $('reports-description').textContent='';
  $('current-reports').textContent=role==='lumos'?'处理结果':'当前异常';$('inspect').hidden=role!=='maintainer';
  const link=(label,path,params)=>{const a=el('a',label,'report-link'),u=new URL(path,location.href);u.searchParams.set('workspace',$('workspace').value);for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);a.href=u.pathname+u.search;return a;};
  function render(){
    if(!data)return;
    let items=reportItems(data,role,history);
    const focus=url.searchParams.get('episode');if(focus)items=items.filter(n=>(n.episode_id||n.id)===focus||n.episode_ids?.includes(focus));
    if(role==='maintainer'&&!history&&!focus)items=items.filter(n=>!['recovered','rechecked'].includes(n.status));
    const schedule=data.inspection;
    $('inspection-status').hidden=role!=='maintainer';
    if(role==='maintainer'&&schedule)$('inspection-status').textContent=(schedule.last_at?'上次检查：'+new Date(schedule.last_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+(schedule.last_status==='failed'?'，未完成。':'。'):'尚未完成检查。')+(schedule.enabled?(schedule.active_id?' 当前检查等待接续。':schedule.due?' 本周检查尚未执行，空闲时补查一次。':' 下次检查：'+new Date(schedule.next_at).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})+'。'):' 每周检查未启用，可手动检查。');
    $('report-count').textContent=items.length+' 项'+(data.executor==='offline'?' · 执行器离线，输入仍保留':'');
    $('current-reports').setAttribute('aria-pressed',String(!history));$('report-history').setAttribute('aria-pressed',String(history));
    const host=$('report-list');host.replaceChildren();
    if(!items.length)host.append(el('p',history?'暂无处理历史。':role==='lumos'?'暂无处理记录。':data.executor==='offline'?'执行器离线，已保存的输入会在恢复后继续处理。':'当前未发现待处理异常。','report-empty'));
    for(const item of items.slice(0,limit)){
      const id=item.episode_id||item.id,card=el('article',undefined,'report-card');
      const head=el('div',undefined,'report-card-heading');head.append(el('h2',item.title),el('span',reportLabel(item,role,history),'report-state'));card.append(head);
      card.append(el('p',(names[item.from_role||item.agent_role]||'系统')+' · '+new Date(item.at||item.updated_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),'report-meta'));
      if(item.count>1)card.append(el('p','发生 '+item.count+' 次','report-meta'));
      card.append(el('p',(role==='lumos'&&item.result)||item.summary||item.error||'本轮尚未返回结果。','report-summary'));
      if(role==='lumos'&&item.result_truncated)card.append(el('p','这里显示结果节选，完整答复可回到原对话查看。','report-meta'));
      if(item.impact)card.append(el('p',item.impact));
      const actions=el('div',undefined,'reports-actions');
      if(item.diagnosis){const detail=el('button','诊断与建议');detail.type='button';detail.setAttribute('aria-haspopup','dialog');detail.onclick=()=>{$('diagnosis-title').textContent=item.title;$('diagnosis-body').textContent=item.diagnosis;$('diagnosis-dialog').showModal();};actions.append(detail);}
      if(item.chat_id)actions.append(link('回到原对话','/chat',{id:item.chat_id,role:item.agent_role||item.from_role||'lumos'}));
      if(item.note)actions.append(link('打开笔记','/notes',{id:item.note.id,role:'librarian'}));
      if(role==='maintainer')actions.append(link('与 Ops 讨论','/chat',{agent:'maintainer',episode:id,role:'maintainer'}));
      else actions.append(link('与 Lumos 讨论','/chat',{agent:'lumos',episode:id,role:'lumos'}));
      card.append(actions);host.append(card);
    }
    $('more-reports').hidden=items.length<=limit;
  }
  async function load(){const current=++generation;$('refresh-reports').disabled=true;try{const r=await fetch('/api/agents?workspace='+$('workspace').value),value=await r.json();if(current!==generation)return;if(!r.ok)throw new Error(value.error||'读取失败');data=value;token=value.token;$('reports-error').textContent='';render();}catch(e){if(current===generation)$('reports-error').textContent=e.message+'；请刷新重试。';}finally{if(current===generation)$('refresh-reports').disabled=false;}}
  function selectHistory(value){history=value;limit=20;url.searchParams.delete('episode');window.history.replaceState(null,'',url);render();}
  $('current-reports').onclick=()=>selectHistory(false);$('report-history').onclick=()=>selectHistory(true);
  $('more-reports').onclick=()=>{limit+=20;render();};$('refresh-reports').onclick=load;
  $('workspace').onchange=()=>{limit=20;data=null;token='';url.searchParams.delete('episode');url.searchParams.set('workspace',$('workspace').value);window.history.replaceState(null,'',url);$('report-list').replaceChildren();load();};
  $('inspect').onclick=async()=>{if(busy||!token)return;busy=true;$('inspect').disabled=true;$('workspace').disabled=true;pending||={request_id:crypto.randomUUID().replaceAll('-',''),workspace:$('workspace').value};try{const r=await fetch('/api/agent-inspect',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),value=await r.json();if(!r.ok){if(r.status>=400&&r.status<500)pending=null;throw new Error(value.error||'检查失败');}pending=null;await load();}catch(e){$('reports-error').textContent=e.message;}finally{busy=false;$('inspect').disabled=false;$('workspace').disabled=!!pending;$('inspect').textContent=pending?'重试检查':'检查一次';}};
  $('close-diagnosis').onclick=()=>$('diagnosis-dialog').close();
  dismissOnBackdrop($('diagnosis-dialog'));
  load();
}
