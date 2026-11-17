'use strict';
function chatTurns(jobs, id) {
  const turns=jobs.filter(n=>n.data.chat_id===id), children=new Map(turns.map(n=>[n.data.chat_parent||'',n])), ordered=[];
  let next=children.get('');
  while(next && ordered.length<turns.length){ordered.push(next);next=children.get(next.id);}
  return ordered;
}
function chatReceipt(job) {
  const d=job.data;
  if(d.status==='pending')return '消息已保存 · 等待 Codex';
  if(d.status==='running')return 'Codex 正在生成答复并整理进展';
  if(d.status==='failed')return '本轮未写入结果 · 可以重试';
  const changes=(job.targets||[]).filter(t=>['action','mainline','person'].includes(t.kind));
  return (changes.length?'已保存 '+changes.length+' 项工作记录':d.destinations?.length?'已保存依据或问题答复':'仅讨论 · 未修改工作记录')+(d.status==='needs_review'?' · 有待确认项':'');
}
function suggestedTasks(state,workspace){
  const contexts=new Map((state.contexts||[]).map(c=>[c.id,c.data]));
  const end=new Date(state.today+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+14);
  if(Number.isNaN(end.getTime()))return {upcoming:[],overdue:[]};
  const until=end.toISOString().slice(0,10),milestones=new Set((state.mainlines||[]).flatMap(l=>l.data.milestone_ids||[]));
  const candidates=(state.tasks||[]).filter(t=>{const c=contexts.get(t.data.context);return c && ['active','waiting'].includes(c.status||'active') && (c.workspace||(t.data.context==='lumos-maintenance'?'lumos':'lingguang'))===workspace && !['done','cancelled'].includes(t.data.status);}).map(t=>{
    const agreed=/^\d{4}-\d{2}-\d{2}$/.test(t.data.due||'');return {...t,date:agreed?t.data.due:t.data.planned_due||'',dateLabel:agreed?'约定交付':'Lumos目标'};
  }).filter(t=>/^\d{4}-\d{2}-\d{2}$/.test(t.date));
  const order=(a,b)=>a.date.localeCompare(b.date)||Number(milestones.has(b.id))-Number(milestones.has(a.id))||a.id.localeCompare(b.id);
  return {upcoming:candidates.filter(t=>t.date>=state.today && t.date<=until).sort(order).slice(0,6),
          overdue:candidates.filter(t=>t.date<state.today).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id)).slice(0,3)};
}
if(typeof module!=='undefined')module.exports={chatTurns,chatReceipt,suggestedTasks};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const uuid=()=>crypto.randomUUID().replaceAll('-','');
  const url=new URL(window.location.href);
  let workspace=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang',chatId=url.searchParams.get('id');
  try{chatId ||= localStorage.getItem('lumos.chat.active.'+workspace);}catch{}chatId ||= uuid();
  let jobs=[],token='',enabled=false,executor='',loaded=false,busy=false,pending=null,timer,generation=0,signature='',listSignature='',error='';
  let selected=[],taskState=null,taskError='',taskRead=0,expanded=false;
  const draftKey=()=>`lumos.chat.${workspace}.${chatId}`;
  function saveDraft(){localStorage.setItem(draftKey(),JSON.stringify({text:$('chat-text').value,pending,selected}));}
  function restoreDraft(){let d={};try{d=JSON.parse(localStorage.getItem(draftKey())||'{}')||{};}catch{}pending=d.pending||null;selected=Array.isArray(d.selected)?d.selected.filter(t=>typeof t.id==='string'&&typeof t.title==='string').slice(0,20):[];$('chat-text').value=d.text||'';}
  function chooseTask(task){
    if(busy||pending)return;
    if(selected.some(t=>t.id===task.id))selected=selected.filter(t=>t.id!==task.id);
    else if(selected.length<20)selected.push({id:task.id,title:(task.short_id?task.short_id+' · ':'')+task.data.text});
    try{saveDraft();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}
    signature='';render();$('chat-text').focus();
  }
  function suggestions(host){
    const welcome=el('div',undefined,'chat-welcome');welcome.append(el('h2','从近期任务开始'),el('p','可选多个任务，再写进展、问题或判断；也可以直接自由表述。'));
    if(!taskState)welcome.append(el('p',taskError||'正在读取近期任务…','muted'));
    else{
      const options=suggestedTasks(taskState,workspace);
      const cards=(tasks,parent)=>{for(const t of tasks){const b=el('button',undefined,'task-prompt');b.type='button';b.setAttribute('aria-pressed',String(selected.some(s=>s.id===t.id)));b.disabled=busy||!!pending;b.append(el('span',(t.short_id?t.short_id+' · ':'')+t.data.text),el('small',t.dateLabel+' '+t.date+(t.date<taskState.today?' · 结果待核对':'')+(t.data.owner?' · '+t.data.owner:'')));b.onclick=()=>chooseTask(t);parent.append(b);}};
      welcome.append(el('p','未来两周 · '+taskState.today+' 起','prompt-period'));
      const grid=el('div',undefined,'task-prompts');cards(options.upcoming,grid);welcome.append(grid);
      if(!options.upcoming.length)welcome.append(el('p','当前空间未来两周暂无已安排的交付节点。','muted'));
      if(options.overdue.length){const fold=el('details',undefined,'overdue-prompts');fold.append(el('summary','原节点已过，结果待核对 · '+options.overdue.length));cards(options.overdue,fold);welcome.append(fold);}
    }
    host.append(welcome);
  }
  async function loadTasks(){const current=++taskRead;try{const r=await fetch('/api/tasks'),data=await r.json();if(current!==taskRead)return;if(!r.ok)throw new Error();taskState=data;taskError='';}catch{if(current!==taskRead)return;taskState=null;taskError='近期任务暂时读取失败，可直接写下任务名称和进展。';}signature='';render();}
  function address(){const u=new URL(window.location.href);u.searchParams.set('workspace',workspace);u.searchParams.set('id',chatId);history.replaceState(null,'',u);try{localStorage.setItem('lumos.chat.active.'+workspace,chatId);}catch{}}
  function controls(){
    const latest=chatTurns(jobs,chatId).at(-1),waiting=latest && ['pending','running','failed'].includes(latest.data.status);
    $('chat-text').readOnly=busy||!!pending;
    $('send-chat').disabled=!loaded||!enabled||busy||(!pending && (waiting||!$('chat-text').value.trim()));
    $('send-chat').textContent=pending?'重试确认':busy?'发送中…':'发送';
    $('chat-model').disabled=busy||!!pending;
    $('chat-workspace').disabled=busy;$('new-chat').disabled=busy;
    const picked=$('selected-tasks');picked.replaceChildren();
    for(const t of selected){const b=el('button',t.title+' ×','selected-task');b.type='button';b.disabled=busy||!!pending;b.setAttribute('aria-label','移除讨论任务：'+t.title);b.onclick=()=>chooseTask({id:t.id});picked.append(b);}
    $('chat-status').textContent=error||(pending?'上次发送结果未确认，重试会核对同一条消息，不会重复创建。':!loaded?'正在读取对话…':!enabled?'此空间尚未启用自主整理。':executor==='offline'?'Codex 执行器未运行；消息可保存，恢复后接续。':waiting?latest.data.status==='failed'?'本轮失败，原话已保留。请在消息下方重试。':'消息已保存，可离开页面；答复完成后会保留在此处。':'明确进展自动保存；每轮答复下方可查看实际更新。');
  }
  function render(){
    const groups=new Map();for(const n of jobs)if(n.data.chat_id && !n.data.chat_parent)groups.set(n.data.chat_id,n);
    const nextListSignature=JSON.stringify([...groups].map(([id,n])=>[id,n.data.title,n.data.created_at]))+chatId+busy;
    if(nextListSignature!==listSignature){
      const list=$('chat-list');list.replaceChildren();
      for(const [id,first] of groups){const b=el('button',first.data.title,'chat-link');b.setAttribute('aria-current',String(id===chatId));b.disabled=busy;b.append(el('small',new Date(first.data.created_at).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})));b.onclick=()=>selectChat(id);list.append(b);}
      listSignature=nextListSignature;
    }
    const turns=chatTurns(jobs,chatId),latest=turns.at(-1);
    $('chat-title').textContent=turns[0]?.data.title||'从一件正在推进的事开始';
    const nextSignature=JSON.stringify(turns);
    if(nextSignature!==signature){
      const host=$('messages'),bottom=host.scrollHeight-host.scrollTop-host.clientHeight<90;
      host.replaceChildren();
      if(!turns.length)suggestions(host);
      for(const job of turns){
        const d=job.data,turn=el('article',undefined,'chat-turn'),user=el('div',undefined,'user-message');
        user.append(el('p','王牧楠 · '+new Date(d.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),'chat-author'),el('p',d.text,'chat-text'));turn.append(user);
        if(job.subjects?.length)user.append(el('p','讨论任务：'+job.subjects.map(t=>t.title).join('、'),'chat-author'));
        const answer=el('div',undefined,'assistant-message');answer.append(el('p','Lumos · '+(d.model||'Codex 默认模型'),'chat-author'));
        if(d.reply)answer.append(el('p',d.reply,'chat-text'));
        const receipt=el('div',undefined,'chat-receipt');receipt.append(el('p',chatReceipt(job)));
        if(d.summary)receipt.append(el('p',d.summary));
        for(const target of job.targets||[])if(['action','mainline'].includes(target.kind)){const a=el('a',target.title);a.href=target.kind==='action'?'/tasks?task='+encodeURIComponent(target.id):'/?line='+encodeURIComponent(target.id);receipt.append(a);}
        for(const [index,q] of (d.questions||[]).entries())receipt.append(el('p',((d.resolutions||[]).some(r=>r.index===index)?'已承接：':'待确认：')+q));
        if(d.error)receipt.append(el('p',d.error,'chat-failed'));
        if(job.id===latest.id && d.status==='failed'){const b=el('button','重试本轮');b.disabled=busy||!!pending;b.onclick=()=>send({request_id:uuid(),id:job.id,expected_revision:d.revision});receipt.append(b);}
        answer.append(receipt);turn.append(answer);host.append(turn);
      }
      if(turns.length && (bottom||!signature))host.scrollTop=host.scrollHeight;
      if(!turns.length)host.scrollTop=0;
      signature=nextSignature;
    }
    controls();
  }
  async function refresh(){
    clearTimeout(timer);const current=generation;
    try{const response=await fetch('/api/intakes?workspace='+workspace),data=await response.json();if(current!==generation)return;if(!response.ok)throw new Error(data.error||'读取失败');
      const finished=data.intakes.some(n=>n.data.chat_id===chatId && ['done','needs_review'].includes(n.data.status) && jobs.find(j=>j.id===n.id)?.data.status!==n.data.status);
      jobs=data.intakes;token=data.token;enabled=data.enabled;executor=data.executor;loaded=true;if(error.startsWith('对话读取失败：'))error='';render();if(finished)loadTasks();
    }catch(e){if(current!==generation)return;loaded=false;error='对话读取失败：'+e.message;controls();}
    if(current===generation)timer=setTimeout(refresh,4000);
  }
  async function selectChat(id,newWorkspace=workspace){
    if(busy)return;
    try{saveDraft();}catch(e){error='草稿无法保存在此浏览器，请先复制正文。';controls();return;}
    workspace=newWorkspace;chatId=id;generation++;clearTimeout(timer);signature='';error='';restoreDraft();address();
    $('chat-workspace').value=workspace;loaded=false;jobs=[];render();loadTasks();await refresh();$('chat-text').focus();
  }
  async function send(request){
    if(busy)return;busy=true;error='';pending ||= request;generation++;clearTimeout(timer);
    try{
      saveDraft();controls();
      const r=await fetch('/api/intakes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),data=await r.json();
      if(!r.ok){if(r.status>=400 && r.status<500){pending=null;saveDraft();}throw new Error(data.error||'发送失败');}
      const retry=!!pending.id;pending=null;
      if(!retry){selected=[];$('chat-text').value='';setExpanded(false);}saveDraft();signature='';
      jobs=[data.intake,...jobs.filter(n=>n.id!==data.intake.id)];render();await refresh();
    }catch(e){error=e.message;timer=setTimeout(refresh,4000);}finally{busy=false;signature='';render();$('chat-text').focus();}
  }
  $('chat-workspace').value=workspace;restoreDraft();address();
  $('new-chat').onclick=()=>chatTurns(jobs,chatId).length?selectChat(uuid()):$('chat-text').focus();
  $('chat-workspace').onchange=()=>{const space=$('chat-workspace').value;let id;try{id=localStorage.getItem('lumos.chat.active.'+space);}catch{}return selectChat(id||uuid(),space);};
  $('chat-text').oninput=()=>{error='';try{saveDraft();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}controls();};
  $('chat-text').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}};
  $('chat-form').onsubmit=e=>{e.preventDefault();if($('send-chat').disabled)return;const text=$('chat-text').value.trim();send(pending||{request_id:uuid(),workspace,chat_id:chatId,chat_parent:chatTurns(jobs,chatId).at(-1)?.id||'',model:$('chat-model').value,text,title:text.slice(0,60),related_ids:selected.map(t=>t.id)});};
  function setExpanded(value){expanded=value;$('conversation').setAttribute('data-writing',value?'expanded':'normal');$('expand-writing').setAttribute('aria-expanded',String(value));$('expand-writing').textContent=value?'收起书写':'展开书写';}
  $('expand-writing').onclick=()=>{setExpanded(!expanded);$('chat-text').focus();};
  $('chat-model').onchange=()=>{try{localStorage.setItem('lumos.chat.model',$('chat-model').value);}catch{}};
  async function models(){try{const r=await fetch('/api/codex-models'),data=await r.json();if(!r.ok)throw new Error();for(const m of data.models){const o=el('option',m.name);o.value=m.id;$('chat-model').append(o);}let selected='';try{selected=localStorage.getItem('lumos.chat.model')||'';}catch{}if(data.models.some(m=>m.id===selected))$('chat-model').value=selected;if(!data.models.length)$('model-help').textContent='暂未读取到本机模型列表，将使用 Codex 默认模型。';}catch{$('model-help').textContent='模型列表读取失败，将使用 Codex 默认模型。';}}
  models();loadTasks();refresh();
}
