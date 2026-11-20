'use strict';
const agentNames={lumos:'Lumos',aipm:'AIPM',librarian:'资料管理员',maintainer:'仓库维护者'};
function chatTurns(jobs, id) {
  const turns=jobs.filter(n=>n.data.chat_id===id), children=new Map(turns.map(n=>[n.data.chat_parent||'',n])), ordered=[];
  let next=children.get('');
  while(next && ordered.length<turns.length){ordered.push(next);next=children.get(next.id);}
  return ordered;
}
function chatReceipt(job) {
  const d=job.data;
  if(d.status==='pending')return '消息已保存 · 等待 Codex';
  if(d.status==='running')return (agentNames[d.agent_steps?.at(-1)?.role||d.agent_role]||'Lumos')+' 正在处理本轮内容';
  if(d.status==='failed')return '本轮未写入结果 · 可以重试';
  const changes=(job.targets||[]).filter(t=>['action','mainline','person'].includes(t.kind));
  return (changes.length?'已保存 '+changes.length+' 项工作记录':d.destinations?.length?'已保存依据或问题答复':'仅讨论 · 未修改工作记录')+(d.status==='needs_review'?' · 有待确认项':'');
}
const chatWorkModel=typeof module!=='undefined'?require('./work-model.js'):window.LumosWorkModel;
function discussionItems(state,workspace,query='',type='all'){
  const contexts=new Map((state.contexts||[]).map(c=>[c.id,c.data]));
  const terms=query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return [...(state.mainlines||[]).map(n=>({...n,kind:'mainline'})),...(state.tasks||[]).map(n=>({...n,kind:'action'}))].filter(n=>{
    const c=contexts.get(n.data.context),d=n.data;
    return c && ['active','waiting'].includes(c.status||'active') && (c.workspace||(n.data.context==='lumos-maintenance'?'lumos':'lingguang'))===workspace
      && (n.kind==='mainline'?d.status!=='archived':!['done','cancelled'].includes(d.status)) && (type==='all'||n.kind===type)
      && terms.every(term=>[n.short_id,d.title,d.text,d.owner,d.summary,d.progress,d.next_step,d.goal].join(' ').toLowerCase().includes(term));
  }).sort((a,b)=>Number(b.kind==='mainline')-Number(a.kind==='mainline') || (a.short_id||a.data.title||'').localeCompare(b.short_id||b.data.title||'','zh-CN',{numeric:true}));
}
function discussionQuestions(state,jobs,workspace){
  if(!state?.today)return {primary:[],rest:[],later:[]};
  const current=chatWorkModel.managementModel({...state,contexts:state.contexts||[],tasks:state.tasks||[]},workspace);
  return chatWorkModel.questionInbox(current.questions.filter(q=>q.line),jobs,workspace);
}
const subjectTitle=n=>(n.kind==='mainline'?'主线 · ':n.short_id?n.short_id+' · ':'')+(n.data.title||n.data.text);
if(typeof module!=='undefined')module.exports={chatTurns,chatReceipt,discussionItems,discussionQuestions};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const uuid=()=>crypto.randomUUID().replaceAll('-','');
  const url=new URL(window.location.href);
  let workspace=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang',chatId=url.searchParams.get('id');
  if(!chatId && (url.searchParams.has('agent')||url.searchParams.has('episode')))chatId=uuid();
  try{chatId ||= localStorage.getItem('lumos.chat.active.'+workspace);}catch{}chatId ||= uuid();
  let jobs=[],token='',enabled=false,executor='',loaded=false,busy=false,pending=null,timer,generation=0,signature='',listSignature='',error='';
  let selected=[],taskState=null,taskError='',taskRead=0,expanded=false,selectedQuestion=null;
  let agentRole='lumos',episodeRef='';
  const draftKey=()=>`lumos.chat.${workspace}.${chatId}`;
  function saveDraft(){localStorage.setItem(draftKey(),JSON.stringify({text:$('chat-text').value,pending,selected,selectedQuestion,agentRole,episodeRef}));}
  function restoreDraft(){let d={};try{d=JSON.parse(localStorage.getItem(draftKey())||'{}')||{};}catch{}pending=d.pending||null;selected=Array.isArray(d.selected)?d.selected.filter(t=>typeof t.id==='string'&&typeof t.title==='string').slice(0,20):[];selectedQuestion=d.selectedQuestion?.key && Array.isArray(d.selectedQuestion.related_ids)?d.selectedQuestion:null;$('chat-text').value=d.text||'';agentRole=agentNames[d.agentRole]?d.agentRole:'lumos';episodeRef=d.episodeRef||'';}
  function changedSelection(){try{saveDraft();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}signature='';render();if($('subject-picker').open)renderPicker();else $('chat-text').focus();}
  function chooseTask(task){
    if(busy||pending)return;
    if(selected.some(t=>t.id===task.id))selected=selected.filter(t=>t.id!==task.id);
    else if(new Set([...selected.map(t=>t.id),...(selectedQuestion?.related_ids||[]),task.id]).size<=20)selected.push({id:task.id,title:subjectTitle(task)});
    else{error='每轮最多选择20个讨论对象，请先移除部分选择。';controls();return;}
    changedSelection();
  }
  function chooseQuestion(q){
    if(busy||pending)return;
    if(new Set([...selected.map(t=>t.id),q.line.id]).size>20){error='每轮最多选择20个讨论对象，请先移除部分选择。';controls();return;}
    selectedQuestion={key:q.key,question_keys:q.question_keys||[q.key],title:q.title,text:q.text,related_ids:[q.line.id]};changedSelection();
  }
  function renderPicker(){
    const host=$('subject-results');host.replaceChildren();
    if(!taskState){$('subject-count').textContent=taskError||'正在读取当前任务与主线…';return;}
    const options=discussionItems(taskState,workspace,$('subject-search').value,$('subject-type').value||'all');
    $('subject-count').textContent='找到 '+options.length+' 项 · 已选 '+selected.length+' 项';
    if(!options.length)host.append(el('p','没有匹配的当前事项，试试其他关键词或切换查看范围。','muted'));
    for(const n of options){const b=el('button',undefined,'task-prompt');b.type='button';b.setAttribute('aria-pressed',String(selected.some(t=>t.id===n.id)));b.disabled=busy||!!pending;
      b.append(el('span',subjectTitle(n)),el('small',n.kind==='mainline'?(n.data.phase||n.data.summary||'主线'):[chatWorkModel.mainlineLabels[n.data.status],n.data.owner||'负责人待定',n.data.planned_due?'当前计划交付 '+n.data.planned_due:n.data.due&&n.data.due!=='long_term'?'约定交付 '+n.data.due:n.data.due==='long_term'?'长期':'未约定交付'].join(' · ')));
      b.onclick=()=>chooseTask(n);host.append(b);
    }
  }
  function suggestions(host){
    const welcome=el('div',undefined,'chat-welcome');welcome.append(el('h2','Lumos 需要你回答'),el('p','先接续主线的关键问题；其他事情可从「搜索任务 / 主线」选择，也可以自由表述。'));
    if(!taskState||!loaded)welcome.append(el('p',taskError||'正在核对当前问题与已提交的答复…','muted'));
    else{
      const inbox=discussionQuestions(taskState,jobs,workspace);
      const cards=(questions,parent)=>{for(const q of questions){const b=el('button',undefined,'question-prompt');b.type='button';b.setAttribute('aria-pressed',String(selectedQuestion?.key===q.key));b.disabled=busy||!!pending;b.append(el('strong',q.title),el('span',q.text),el('small',q.timingReason+' · 点击回答'));b.onclick=()=>chooseQuestion(q);parent.append(b);}};
      cards(inbox.primary,welcome);
      if(!inbox.primary.length)welcome.append(el('p','当前没有需要立即回答的主线问题。可以搜索并选择你想讨论的事项。','muted'));
      for(const [label,questions] of [['其他当前问题',inbox.rest],['后续再跟进',inbox.later]])if(questions.length){const fold=el('details',undefined,'overdue-prompts');fold.append(el('summary',label+' · '+questions.length));cards(questions,fold);welcome.append(fold);}
    }
    host.append(welcome);
  }
  async function loadTasks(){const current=++taskRead;try{const r=await fetch('/api/tasks'),data=await r.json();if(current!==taskRead)return;if(!r.ok)throw new Error();taskState=data;taskError='';}catch{if(current!==taskRead)return;taskState=null;taskError='任务与主线暂时读取失败，可直接写下名称和进展。';}signature='';render();if($('subject-picker').open)renderPicker();}
  function address(){const u=new URL(window.location.href);u.searchParams.set('workspace',workspace);u.searchParams.set('id',chatId);u.searchParams.delete('agent');u.searchParams.delete('episode');history.replaceState(null,'',u);try{localStorage.setItem('lumos.chat.active.'+workspace,chatId);}catch{}}
  function controls(){
    const latest=chatTurns(jobs,chatId).at(-1),waiting=latest && ['pending','running','failed'].includes(latest.data.status);
    $('chat-text').readOnly=busy||!!pending;
    $('send-chat').disabled=!loaded||!enabled||busy||(!pending && (waiting||!$('chat-text').value.trim()));
    $('send-chat').textContent=pending?'重试确认':busy?'发送中…':'发送';
    $('chat-model').disabled=busy||!!pending;
    $('chat-agent').value=agentRole;$('chat-agent').disabled=busy||!!pending;
    $('writing-label').textContent='写给 '+agentNames[agentRole];
    $('chat-options-label').textContent=agentNames[agentRole]+' · 对话设置';
    $('episode-reference').textContent=episodeRef?'正在反馈一次执行：'+episodeRef:'';
    $('chat-workspace').disabled=busy;$('new-chat').disabled=busy;$('choose-subjects').disabled=busy||!!pending;
    const question=$('selected-question');question.replaceChildren();
    if(selectedQuestion){question.append(el('strong','正在回答 · '+selectedQuestion.title),el('p',selectedQuestion.text));const clear=el('button','取消问题选择');clear.type='button';clear.disabled=busy||!!pending;clear.onclick=()=>{selectedQuestion=null;changedSelection();};question.append(clear);}
    const picked=$('selected-tasks');picked.replaceChildren();
    for(const t of selected){const b=el('button',t.title+' ×','selected-task');b.type='button';b.disabled=busy||!!pending;b.setAttribute('aria-label','移除讨论对象：'+t.title);b.onclick=()=>chooseTask({id:t.id});picked.append(b);}
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
    const nextSignature=JSON.stringify(turns)+(turns.length?'':JSON.stringify(jobs.map(n=>[n.id,n.data.revision]))+loaded);
    if(nextSignature!==signature){
      const host=$('messages'),bottom=host.scrollHeight-host.scrollTop-host.clientHeight<90;
      host.replaceChildren();
      if(!turns.length)suggestions(host);
      for(const job of turns){
        const d=job.data,turn=el('article',undefined,'chat-turn'),user=el('div',undefined,'user-message');
        user.append(el('p','王牧楠 · '+new Date(d.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),'chat-author'),el('p',d.text,'chat-text'));turn.append(user);
        if(d.question_text)user.append(el('p','回答问题：'+d.question_text,'chat-author'));
        if(job.subjects?.length)user.append(el('p','讨论对象：'+job.subjects.map(t=>t.title).join('、'),'chat-author'));
        const answer=el('div',undefined,'assistant-message');answer.append(el('p',(agentNames[d.agent_role]||'Lumos')+' · '+(d.model||'Codex 默认模型'),'chat-author'));
        if(d.reply)answer.append(el('p',d.reply,'chat-text'));
        const receipt=el('div',undefined,'chat-receipt');receipt.append(el('p',chatReceipt(job)));
        if(d.summary)receipt.append(el('p',d.summary));
        const log=el('a','查看处理经过');log.href='/agents?workspace='+workspace+'&episode='+encodeURIComponent(job.id);receipt.append(log);
        for(const target of job.targets||[])if(['action','mainline'].includes(target.kind)){const a=el('a',target.title);a.href=target.kind==='action'?'/tasks?task='+encodeURIComponent(target.id):'/?line='+encodeURIComponent(target.id);receipt.append(a);}
        for(const [index,q] of (d.questions||[]).entries()){
          const answers=(d.resolutions||[]).filter(r=>r.index===index),last=answers.at(-1);
          receipt.append(el('p',!last?'待确认：'+q:last.state==='pending'?'剩余待答：'+last.remaining:last.state==='waiting'?'等待后续跟进：'+last.remaining:'原问题已答'));
          if(last){const history=el('details');history.append(el('summary','原问题与答复历史'),el('p',q));for(const a of answers)history.append(el('p',a.answer),el('p','答复原文：'+a.excerpt));receipt.append(history);}
        }
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
      if(!retry){selected=[];selectedQuestion=null;episodeRef='';$('chat-text').value='';setExpanded(false);}saveDraft();signature='';
      jobs=[data.intake,...jobs.filter(n=>n.id!==data.intake.id)];render();await refresh();
    }catch(e){error=e.message;timer=setTimeout(refresh,4000);}finally{busy=false;signature='';render();$('chat-text').focus();}
  }
  $('chat-workspace').value=workspace;restoreDraft();
  if(!pending){
    if(agentNames[url.searchParams.get('agent')])agentRole=url.searchParams.get('agent');
    if(url.searchParams.get('episode'))episodeRef=url.searchParams.get('episode');
  }
  try{saveDraft();address();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}
  $('chat-agent').onchange=()=>{agentRole=$('chat-agent').value;changedSelection();};
  $('new-chat').onclick=()=>chatTurns(jobs,chatId).length?selectChat(uuid()):$('chat-text').focus();
  $('chat-workspace').onchange=()=>{const space=$('chat-workspace').value;let id;try{id=localStorage.getItem('lumos.chat.active.'+space);}catch{}return selectChat(id||uuid(),space);};
  $('chat-text').oninput=()=>{error='';try{saveDraft();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}controls();};
  $('chat-text').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}};
  $('chat-form').onsubmit=e=>{e.preventDefault();if($('send-chat').disabled)return;const text=$('chat-text').value.trim();send(pending||{request_id:uuid(),workspace,chat_id:chatId,chat_parent:chatTurns(jobs,chatId).at(-1)?.id||'',model:$('chat-model').value,agent_role:agentRole,...(episodeRef?{episode_ref:episodeRef}:{}),text,title:text.slice(0,60),related_ids:[...new Set([...selected.map(t=>t.id),...(selectedQuestion?.related_ids||[])])],...(selectedQuestion?{question_key:selectedQuestion.key,question_keys:selectedQuestion.question_keys||[selectedQuestion.key],question_text:selectedQuestion.question_keys?.length>1?selectedQuestion.title+' · 合并跟进':selectedQuestion.text}:{})});};
  function setExpanded(value){expanded=value;$('conversation').setAttribute('data-writing',value?'expanded':'normal');$('expand-writing').setAttribute('aria-expanded',String(value));$('expand-writing').textContent=value?'收起书写':'展开书写';}
  $('choose-subjects').onclick=()=>{$('subject-search').value='';$('subject-type').value='all';renderPicker();$('subject-picker').showModal();$('subject-search').focus();loadTasks();};
  $('subject-search').oninput=renderPicker;$('subject-type').onchange=renderPicker;
  $('close-subject-picker').onclick=()=>$('subject-picker').close();$('subject-picker').onclose=()=>{$('chat-text').focus();};
  dismissOnBackdrop($('subject-picker'));
  $('expand-writing').onclick=()=>{setExpanded(!expanded);$('chat-text').focus();};
  $('chat-model').onchange=()=>{try{localStorage.setItem('lumos.chat.model',$('chat-model').value);}catch{}};
  async function models(){try{const r=await fetch('/api/codex-models'),data=await r.json();if(!r.ok)throw new Error();for(const m of data.models){const o=el('option',m.name);o.value=m.id;$('chat-model').append(o);}let selected='';try{selected=localStorage.getItem('lumos.chat.model')||'';}catch{}if(data.models.some(m=>m.id===selected))$('chat-model').value=selected;if(!data.models.length)$('model-help').textContent='暂未读取到本机模型列表，将使用 Codex 默认模型。';}catch{$('model-help').textContent='模型列表读取失败，将使用 Codex 默认模型。';}}
  models();loadTasks();refresh();
}
