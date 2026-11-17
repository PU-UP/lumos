'use strict';
const mainlineLabels = {todo:'待处理', doing:'进行中', blocked:'受阻', done:'已完成', cancelled:'已取消'};
const isOpenTask = t => !['done', 'cancelled'].includes(t.data.status);
const deliveryDate = t => /^\d{4}-\d{2}-\d{2}$/.test(t.data.due || '') ? t.data.due : '';
const targetDate = t => deliveryDate(t) || t.data.planned_due || '';
const deliverySort = (a, b) => (targetDate(a) || '9999').localeCompare(targetDate(b) || '9999') || a.id.localeCompare(b.id);
const mainlineSort = (a, b) => (a.data.priority || 'P4').localeCompare(b.data.priority || 'P4') || (a.data.order || 0)-(b.data.order || 0) || a.id.localeCompare(b.id);
function managementModel(state, workspace) {
  const spaceOf = context => state.contexts.find(c => c.id === context)?.data.workspace || (context === 'lumos-maintenance' ? 'lumos' : 'lingguang');
  const tasks = state.tasks.filter(t => spaceOf(t.data.context) === workspace);
  const lines = (state.mainlines || []).filter(l => spaceOf(l.data.context) === workspace && l.data.status !== 'archived');
  const assigned = new Set(lines.flatMap(l => l.data.task_ids || []));
  const entries = lines.sort(mainlineSort).map(line => ({line, tasks: tasks.filter(t => (line.data.task_ids || []).includes(t.id))}));
  const independent = tasks.filter(t => !assigned.has(t.id));
  const issues = [];
  for (const entry of entries) {
    const blocked = entry.tasks.filter(t => isOpenTask(t) && t.data.status === 'blocked');
    const overdue = entry.tasks.filter(t => isOpenTask(t) && (entry.line.data.milestone_ids || []).includes(t.id) && deliveryDate(t) && deliveryDate(t) < state.today);
    const affected = [...new Map([...blocked, ...overdue].map(t => [t.id,t])).values()];
    const d=entry.line.data, reviewDue=d.review_on && d.review_on<=state.today &&
      (d.review_checked_on!==d.review_on || (d.review_checked_revision||0)!==(d.review_revision||0));
    if (affected.length || reviewDue) issues.push({title:d.title, line:entry.line, tasks:affected,
      severity:blocked.length ? 0 : 1, reason:blocked.length ? '有受阻事项，需核对影响与协作' : overdue.length ? '阶段交付已过原计划日期，需核对结果' : '已到复核日，等待 Agent 核对现有依据',
      date:affected.map(deliveryDate).filter(Boolean).sort()[0] || d.review_on || '9999'});
  }
  for (const task of independent.filter(t => isOpenTask(t) && (t.data.status === 'blocked' || t.data.priority === 'high' || (deliveryDate(t) && deliveryDate(t) < state.today)))) {
    issues.push({title:task.data.text, tasks:[task], severity:task.data.status === 'blocked' ? 0 : 1,
      reason:task.data.status === 'blocked' ? '独立事项受阻' : '独立事项需核对', date:deliveryDate(task) || '9999'});
  }
  issues.sort((a,b) => a.severity-b.severity || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return {entries, independent, issues, tasks};
}
function milestoneTasks(entry) {
  return entry.tasks.filter(t => isOpenTask(t) && (entry.line.data.milestone_ids || []).includes(t.id)).sort(deliverySort);
}
function matchesTask(task, query) {
  return [task.short_id, task.data.text, task.data.progress, task.data.next_step, task.data.owner].join(' ').toLowerCase().includes(query.toLowerCase());
}
function submission(post, initial=null) {
  let pending=initial, busy=false;
  return {get pending(){return pending;}, async send(request,onPending=()=>{}) {
    if(busy)return null;
    busy=true;pending ||= request;onPending(pending);
    try {const result=await post(pending);pending=null;onPending(null);return result;}
    catch(e){if(e.confirmed){pending=null;onPending(null);}throw e;}
    finally{busy=false;}
  }};
}
if (typeof module !== 'undefined') module.exports = {managementModel, milestoneTasks, deliveryDate, targetDate, matchesTask, submission};

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => {const n=document.createElement(tag); if(text !== undefined)n.textContent=text; if(cls)n.className=cls; return n;};
  const deliveryView = window.location.pathname === '/delivery' || new URLSearchParams(window.location.search).get('view') === 'delivery';
  const preferencesKey = 'lumos.management.v1';
  let state, model, pinned=[], detailRequest=0, attentionOpen=true, writing=false;
  const reviews=new Map(), reviewDrafts=new Map();
  function remember() {
    try {localStorage.setItem(preferencesKey, JSON.stringify({workspace:$('workspace').value,pinned,attentionOpen:$('attention').open}));}
    catch {$('preference-message').textContent='无法保存浏览器偏好；本次查看仍有效。';}
  }
  try {
    const p=JSON.parse(localStorage.getItem(preferencesKey));
    if(['lingguang','lumos'].includes(p?.workspace)) $('workspace').value=p.workspace;
    if(Array.isArray(p?.pinned)) pinned=p.pinned.filter(x=>typeof x==='string');
    if(typeof p?.attentionOpen==='boolean')attentionOpen=p.attentionOpen;
  } catch {$('preference-message').textContent='未能读取查看偏好，使用默认设置。';}
  $('attention').open=attentionOpen;
  document.querySelector('.attention-toggle').textContent=attentionOpen?'收起':'展开';
  $('attention').ontoggle=()=>{document.querySelector('.attention-toggle').textContent=$('attention').open?'收起':'展开';remember();};
  async function post(url,request){
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':state.token},body:JSON.stringify(request)});
    const data=await response.json();
    if(!response.ok){const error=new Error(data.error||'保存失败');error.confirmed=response.status>=400 && response.status<500;throw error;}
    return data;
  }
  function setWriting(value){writing=value;$('refresh').disabled=value;$('workspace').disabled=value;}
  function reviewControl(line){
    const form=el('form',undefined,'review-control'),label=el('label','下次复核'),date=el('input'),save=el('button','保存'),message=el('span',line.data.review_on?'已保存：'+line.data.review_on:'未安排复核', 'review-message');
    if(line.data.review_on && line.data.review_checked_on===line.data.review_on && (line.data.review_checked_revision||0)===(line.data.review_revision||0))message.textContent='本次已复核';
    const savedMessage=message.textContent;
    date.type='date';date.value=line.data.review_on||'';date.setAttribute('aria-label',line.data.title+' · 下次复核');
    date.disabled=!state.writable;save.type='submit';save.disabled=!state.writable;
    if(reviewDrafts.has(line.id))date.value=reviewDrafts.get(line.id);
    save.hidden=date.value===(line.data.review_on||'');
    if(!save.hidden)message.textContent='尚未保存';
    const sender=reviews.get(line.id)||submission(r=>post('/api/mainline-review',r));reviews.set(line.id,sender);
    if(sender.pending){date.value=sender.pending.review_on;date.disabled=true;save.hidden=false;save.textContent='重试保存';message.textContent='上次保存结果未确认，请重试保存。';}
    date.oninput=()=>{save.hidden=date.value===(line.data.review_on||'');if(save.hidden)reviewDrafts.delete(line.id);else reviewDrafts.set(line.id,date.value);message.textContent=save.hidden?savedMessage:'尚未保存';};
    date.onchange=()=>{date.oninput();if(!save.hidden)form.requestSubmit();};
    label.append(date);form.append(label,save,message);message.setAttribute('role','status');
    form.onsubmit=async event=>{
      event.preventDefault();if(writing || !state.writable){message.textContent='尚未保存，请稍后点击保存。';return;}
      setWriting(true);save.disabled=true;date.disabled=true;message.textContent='保存中…';
      try {await sender.send({request_id:crypto.randomUUID().replaceAll('-',''),id:line.id,expected_seq:state.seq,review_on:date.value});reviewDrafts.delete(line.id);message.textContent='已保存'+(date.value?'：'+date.value:'：未安排复核');await load();}
      catch(e){message.textContent=e.message+' 输入已保留，请重试保存。';save.hidden=false;save.textContent=sender.pending?'重试保存':'保存';}
      finally{setWriting(false);save.disabled=false;date.disabled=!!sender.pending;}
    };
    return form;
  }
  let feedbackSender,feedbackWorkspace;
  const feedbackKey=()=> 'lumos.feedback.'+feedbackWorkspace;
  function stashFeedback(){
    try{localStorage.setItem(feedbackKey(),JSON.stringify({text:$('feedback-text').value,target:$('feedback-target').value,pending:feedbackSender?.pending}));}
    catch{$('feedback-status').textContent='浏览器无法保存草稿，请保持页面打开或复制正文。';}
  }
  function restoreFeedback(){
    feedbackWorkspace=$('workspace').value;let draft={};
    try{draft=JSON.parse(localStorage.getItem(feedbackKey()))||{};}catch{}
    $('feedback-text').value=draft.text||'';$('feedback-target').value=draft.target||'';
    feedbackSender=submission(r=>post('/api/intakes',r),draft.pending||null);
    $('feedback-submit').textContent=feedbackSender.pending?'重试提交':'交给 Agent 整理';
    $('feedback-status').textContent=feedbackSender.pending?'上次提交结果未确认，重试会核对同一份内容。':'提交后由 Agent 整理，可在下方查看结果。';
  }
  $('feedback-text').oninput=stashFeedback;$('feedback-target').onchange=stashFeedback;
  $('feedback-form').onsubmit=async event=>{
    event.preventDefault();if(writing || !state?.writable)return;
    const text=$('feedback-text').value.trim();if(!text && !feedbackSender.pending){$('feedback-status').textContent='请先填写进展或处理意见。';$('feedback-text').focus();return;}
    const target=$('feedback-target').value;
    const request=feedbackSender.pending||{request_id:crypto.randomUUID().replaceAll('-',''),workspace:feedbackWorkspace,text,title:'主线页反馈',related_ids:target?[target]:[]};
    setWriting(true);$('feedback-submit').disabled=true;$('feedback-status').textContent='正在提交…';
    try{
      await feedbackSender.send(request,stashFeedback);
      if($('feedback-text').value.trim()===request.text)$('feedback-text').value='';
      stashFeedback();$('feedback-status').textContent='已保存，等待 Agent 整理。原文与处理结果会保留在下方。';
      $('intake-panel').open=true;window.LumosIntake?.watch($('intake-list'),feedbackWorkspace);
    }catch(e){$('feedback-status').textContent='未能提交：'+e.message+' 正文已保留。';}
    finally{setWriting(false);$('feedback-submit').disabled=false;$('feedback-submit').textContent=feedbackSender.pending?'重试提交':'交给 Agent 整理';}
  };
  function taskLink(task, progress=false) {
    const link=el('a',undefined,'task-link');
    link.href='/tasks?task='+encodeURIComponent(task.id)+'&return='+encodeURIComponent(window.location.pathname+window.location.search);
    link.append(el('strong',task.data.text));
    if(task.data.priority==='P3')link.append(el('span','P3 · 非项目事务','task-meta'));
    const due=task.data.due==='long_term'?'长期':task.data.due || '未约定';
    const overdue=isOpenTask(task) && deliveryDate(task) && deliveryDate(task)<state.today;
    if(task.data.planned_due)link.append(el('span','Agent目标 '+task.data.planned_due+(task.data.planning_reason?' · '+task.data.planning_reason:''),'task-meta'));
    link.append(el('span', `${mainlineLabels[task.data.status]} · ${task.data.owner || '王牧楠'}${task.data.owner_basis==='agent'?'（Agent安排）':''} · 原交付 ${due}${overdue?' · 已过计划日期，结果待核对':''}`, 'task-meta'));
    if(progress && task.data.progress) link.append(el('p',task.data.progress,'task-progress'));
    return link;
  }
  function fold(title, parent) {const d=el('details');d.append(el('summary',title));parent.append(d);return d;}
  function lineButton(line, text='查看主线', cls='details-button') {const b=el('button',text,cls);b.onclick=()=>openLine(line.id);return b;}
  function dateGroups(tasks, parent) {
    const dated=tasks.filter(targetDate);
    if(!tasks.length) parent.append(el('p','尚无当前阶段交付。','muted'));
    for(const day of [...new Set(dated.map(targetDate))].sort()) {
      const section=el('div',undefined,'delivery-group');section.append(el('h3',day,'delivery-date'));
      for(const t of dated.filter(t=>targetDate(t)===day))section.append(taskLink(t));
      parent.append(section);
    }
    for(const [label,items] of [['长期',tasks.filter(t=>t.data.due==='long_term'&&!targetDate(t))],['未约定交付时间',tasks.filter(t=>!t.data.due&&!targetDate(t))]]) {
      if(items.length){const d=fold(label+' · '+items.length,parent);d.className='delivery-extra';for(const t of items)d.append(taskLink(t));}
    }
  }
  function render() {
    model=managementModel(state,$('workspace').value);
    $('attention-count').textContent=model.issues.length?String(model.issues.length):'';
    const target=$('feedback-target'),selected=target.value;target.replaceChildren(new Option('综合反馈',''));
    for(const e of model.entries)target.append(new Option(e.line.data.title,e.line.id));
    for(const issue of model.issues.filter(i=>!i.line))target.append(new Option(issue.title,issue.tasks[0].id));
    target.value=[...target.options].some(o=>o.value===selected)?selected:'';
    if(feedbackWorkspace!==$('workspace').value)restoreFeedback();
    $('feedback-submit').disabled=!state.writable;
    const query=$('search').value.trim();$('clear-search').hidden=!query;
    $('attention').hidden=deliveryView || !!query;
    $('attention-items').replaceChildren();
    if(!model.issues.length)$('attention-items').append(el('p','暂无已识别的受阻或逾期阶段交付；请结合各主线的来源日期判断。','attention-empty'));
    for(const issue of model.issues) {
      const row=el('details',undefined,'attention-item');
      const heading=el('summary',issue.title+' · '+issue.reason);row.append(heading);
      if(issue.line)row.append(lineButton(issue.line));
      for(const t of issue.tasks)row.append(taskLink(t));
      $('attention-items').append(row);
    }
    $('mainlines').replaceChildren();
    const entries=model.entries.filter(e=>!query || [e.line.data.title,e.line.data.summary,e.line.data.goal].join(' ').toLowerCase().includes(query.toLowerCase()) || (deliveryView?milestoneTasks(e):e.tasks).some(t=>matchesTask(t,query)));
    entries.sort((a,b)=>Number(pinned.includes(b.line.id))-Number(pinned.includes(a.line.id)) || mainlineSort(a.line,b.line));
    if(!entries.length)$('mainlines').append(el('p',query?(deliveryView?'没有匹配的主线或阶段成果。':'没有匹配的主线；相关任务见下方。'):'此空间尚未建立主线，独立事项仍可在下方查看。','empty-state'));
    for(const entry of entries) {
      const {line}=entry,d=line.data;
      const row=el('article',undefined,'mainline-row'),heading=el('div',undefined,'mainline-heading'),title=el('div',undefined,'mainline-title');
      const h=el('h2');h.append(lineButton(line,d.title,'title-button'));title.append(h,el('span',d.phase || '阶段待明确','phase'));
      if(d.priority)title.prepend(el('strong',d.priority,'phase'));
      const actions=el('div',undefined,'mainline-actions'),pin=el('button',pinned.includes(line.id)?'已置顶':'置顶','pin');
      pin.setAttribute('aria-pressed',String(pinned.includes(line.id)));pin.setAttribute('aria-label',d.title+' · 置顶');
      pin.onclick=()=>{pinned=pinned.includes(line.id)?pinned.filter(i=>i!==line.id):[...pinned,line.id];remember();render();};
      actions.append(pin,lineButton(line));heading.append(title,actions);row.append(heading);
      if(deliveryView)dateGroups(milestoneTasks(entry),row);
      else {
        row.append(el('p',d.summary,'mainline-summary'));
        if(d.risk)row.append(el('p','关注：'+d.risk,'mainline-risk'));
        const meta=el('div',undefined,'mainline-meta'),next=milestoneTasks(entry).filter(targetDate)[0];
        if(next){const label=deliveryDate(next)?(deliveryDate(next)<state.today?'待核对交付':'下一交付'):'Agent目标';const a=el('a',`${label}：${targetDate(next)} · ${next.data.text}`);a.href='/tasks?task='+encodeURIComponent(next.id)+'&return='+encodeURIComponent('/?line='+line.id);meta.append(a);}
        else meta.append(el('span','下一阶段交付待明确'));
        meta.append(el('span','摘要依据 '+(d.as_of || '日期未记录')));row.append(meta,reviewControl(line));
      }
      $('mainlines').append(row);
    }
    const result=$('search-results');result.replaceChildren();result.hidden=deliveryView || !query;
    if(query && !deliveryView){const found=model.tasks.filter(t=>matchesTask(t,query));result.append(el('h2','匹配任务 · '+found.length));for(const t of found)result.append(taskLink(t));}
    const independent=model.independent.filter(isOpenTask);
    $('independent-title').textContent='独立事项与未关联任务 · '+independent.length;
    $('independent-items').replaceChildren();
    if(!independent.length)$('independent-items').append(el('p','没有未关联的未结束任务。','muted'));
    for(const task of independent)$('independent-items').append(taskLink(task));
    $('independent').hidden=deliveryView || !!query;
    const past=model.independent.filter(t=>!isOpenTask(t));
    if(past.length){const closed=fold('已结束独立事项 · '+past.length,$('independent-items'));for(const t of past)closed.append(taskLink(t));}
    $('sync').textContent='记录日期 '+state.today+' · 已读取最新版本';
  }
  async function read(url){const r=await fetch(url);const data=await r.json();if(!r.ok)throw new Error(data.error||'读取失败');return data;}
  async function load() {
    $('refresh').disabled=true;$('message').textContent='正在读取……';
    try {
      const fresh=await read('/api/tasks');
      if(!Array.isArray(fresh.mainlines))throw new Error('当前服务尚未加载主线功能，请重启 Lumos 服务后刷新。');
      state=fresh;render(); if(window.LumosIntake) window.LumosIntake.watch($('intake-list'),$('workspace').value);
      $('message').textContent=state.integrity?.drafts_or_missing_working_copies?.length?'存在未吸收的工作文档改动，当前展示正式保存记录。':'';
      const id=new URLSearchParams(window.location.search).get('line');
      if(id && model.entries.some(e=>e.line.id===id))await openLine(id);
    }catch(e){$('message').textContent='未能刷新：'+e.message+(state?'。下方仍为上次读取的内容。':'');}
    finally{$('refresh').disabled=writing;}
  }
  async function openLine(id) {
    const request=++detailRequest,dialog=$('mainline-detail'),body=$('detail-content');
    $('detail-title').textContent=model.entries.find(e=>e.line.id===id)?.line.data.title || '主线详情';
    body.replaceChildren(el('p','正在读取……'));
    if(!dialog.open)dialog.showModal();
    const url=new URL(window.location.href);url.searchParams.set('line',id);history.replaceState(null,'',url);
    try {
      const detail=await read('/api/mainline?id='+encodeURIComponent(id));if(request!==detailRequest || !dialog.open)return;
      const d=detail.mainline.data;body.replaceChildren();
      if(d.priority)body.append(el('p',`优先级 ${d.priority}${d.priority_basis==='agent'?' · Agent安排':''}${d.priority_reason?'：'+d.priority_reason:''}`));
      body.append(el('h3','目标'),el('p',d.goal),el('h3','当前结论'),el('p',d.summary),el('p','摘要依据 '+(d.as_of||'日期未记录'),'muted'),reviewControl(detail.mainline));
      const live=detail.tasks.filter(t=>!['archived','retained'].includes(t.context_status));
      body.append(el('h3','阶段交付'));dateGroups(milestoneTasks({line:detail.mainline,tasks:live}),body);
      body.append(el('h3','风险与下一步'),el('p',d.risk || '暂无已记录风险；不代表已经验证正常。'),el('p',d.next_step || '下一步待明确'));
      const related=el('div',undefined,'detail-links');for(const other of d.related_mainlines || []){const l=model.entries.find(e=>e.line.id===other)?.line;if(l)related.append(lineButton(l,l.data.title));}body.append(related);
      const tasks=fold('执行细项 · '+live.filter(isOpenTask).length,body);
      for(const t of live.filter(isOpenTask).sort((a,b)=>Number(b.data.status==='blocked')-Number(a.data.status==='blocked') || deliverySort(a,b)))tasks.append(taskLink(t,true));
      const past=detail.tasks.filter(t=>!isOpenTask(t)||['archived','retained'].includes(t.context_status));
      if(past.length){const closed=fold('已结束 / 历史脉络任务 · '+past.length,body);for(const t of past)closed.append(taskLink(t,true));}
      const sources=fold('依据与原文 · '+detail.sources.length,body);
      sources.append(el('p',d.source.ref,'source-text'));if(d.source.quote)sources.append(el('p',d.source.quote,'source-text'));if(d.source.reason)sources.append(el('p',d.source.reason,'source-text'));for(const source of detail.sources){const doc=fold(source.title,sources);doc.append(el('p',source.text,'source-text'));}
      const versions=fold('主线历史 · '+detail.history.length,body);
      for(const h of detail.history){const entry=fold(h.at.slice(0,10)+' · '+h.reason,versions);entry.append(el('p',h.after?.data?.summary || ''));}
    }catch(e){if(request===detailRequest && dialog.open)body.replaceChildren(el('p','读取失败：'+e.message));}
  }
  function closed(){detailRequest++;const url=new URL(window.location.href);url.searchParams.delete('line');history.replaceState(null,'',url);}
  $('close-detail').onclick=()=>$('mainline-detail').close();$('mainline-detail').addEventListener('close',closed);
  $('workspace').onchange=()=>{if($('mainline-detail').open)$('mainline-detail').close();const url=new URL(window.location.href);url.searchParams.delete('line');history.replaceState(null,'',url);remember();if(state)render();if(window.LumosIntake)window.LumosIntake.watch($('intake-list'),$('workspace').value);};
  $('refresh').onclick=load;$('search').oninput=()=>{if(state)render();};$('clear-search').onclick=()=>{$('search').value='';render();$('search').focus();};
  $(deliveryView?'nav-delivery':'view-summary').setAttribute('aria-current','page');
  if(deliveryView){$('page-title').textContent='主线交付时间线';document.title='Lumos · 主线交付';$('page-description').textContent='只看各主线的阶段成果与交付节点。';}
  load();
}
