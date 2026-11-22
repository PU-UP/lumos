'use strict';
const agentNames={lumos:'Lumos',aipm:'AIPM',librarian:'Atlas',maintainer:'Ops'};
const roleConversation={
  lumos:{title:'先看清最重要的事。',hint:'告诉我目标、进展或需要取舍的事。',prompts:['帮我梳理当前最重要的事情。','我想讨论一个需要取舍的问题。']},
  aipm:{title:'把下一步安排清楚。',hint:'告诉我哪项任务有变化、卡在哪里，或需要怎样安排。',prompts:['检查当前主线的前置依赖和下一步安排。','我想补充一项任务的进展。']},
  librarian:{title:'从资料找到有出处的答案。',hint:'告诉我要找的主题或文件名，也可以交代资料需要怎样整理。',prompts:['我想查找一份资料，请先帮我确认检索范围。','请说明当前已登记资料的范围与尚未读取的内容。']},
  maintainer:{title:'把运行问题说清楚。',hint:'描述现象、发生时间或相关执行，我会先核对诊断依据。',prompts:['请核对当前运行异常，区分已知事实和可能原因。','我想反馈一个使用中遇到的问题。']}
};
function replyBlocks(text){
  const blocks=[];
  for(const line of text.split('\n')){
    if(!line.trim()){continue;}
    const bullet=line.match(/^\s*(?:[-*•]|\d+[.)、])\s+(.+)$/);
    if(bullet){if(blocks.at(-1)?.kind!=='list')blocks.push({kind:'list',items:[]});blocks.at(-1).items.push(bullet[1]);}
    else blocks.push({kind:'paragraph',text:line});
  }
  return blocks;
}
function answerText(text,question){return [typeof question?.answer==='string'?question.answer:'',text.trim()].filter(Boolean).join('\n\n');}
function chatTurns(jobs, id) {
  const turns=jobs.filter(n=>n.data.chat_id===id), children=new Map(turns.map(n=>[n.data.chat_parent||'',n])), ordered=[];
  let next=children.get('');
  while(next && ordered.length<turns.length){ordered.push(next);next=children.get(next.id);}
  return ordered;
}
function chatReceipt(job) {
  const d=job.data;
  if(d.status==='pending')return '消息已保存 · 等待 Codex';
  if(d.status==='running')return d.agent_steps?.at(-1)?.phase==='decide'?'Lumos 正在决定安排':(agentNames[d.agent_steps?.at(-1)?.role||d.agent_role]||'Lumos')+' 正在处理本轮内容';
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
if(typeof module!=='undefined')module.exports={chatTurns,chatReceipt,discussionItems,discussionQuestions,replyBlocks,roleConversation,answerText};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const uuid=()=>crypto.randomUUID().replaceAll('-','');
  const url=new URL(window.location.href);
  let requestedRole=agentNames[url.searchParams.get('role')||url.searchParams.get('agent')]?url.searchParams.get('role')||url.searchParams.get('agent'):'lumos';
  let workspace=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang',chatId=url.searchParams.get('id');
  if(!chatId && (url.searchParams.has('agent')||url.searchParams.has('episode')))chatId=uuid();
  try{chatId ||= localStorage.getItem('lumos.chat.active.'+requestedRole+'.'+workspace)||(requestedRole==='lumos'?localStorage.getItem('lumos.chat.active.'+workspace):'');}catch{}chatId ||= uuid();
  let sessions=[],metaSignature='',metadataDirty=false,sessionBusy=false,creationRequest=null,metadataRequest=null;
  let jobs=[],token='',enabled=false,executor='',loaded=false,busy=false,pending=null,timer,generation=0,signature='',listSignature='',error='';
  let selected=[],taskState=null,taskError='',taskRead=0,expanded=false,selectedQuestion=null;
  let agentRole=requestedRole,episodeRef='';
  let modelsReady=false,modelSignature='',availableModels=[];
  const currentSession=()=>sessions.find(n=>n.data.chat_id===chatId);
  const readOnly=()=>['closed','legacy'].includes(currentSession()?.data.status);
  const draftKey=()=>`lumos.chat.${workspace}.${chatId}`;
  function saveDraft(){localStorage.setItem(draftKey(),JSON.stringify({text:$('chat-text').value,pending,selected,selectedQuestion,agentRole,episodeRef,metadataRequest,memoDraft:metadataDirty?{title:$('session-title').value,memo:$('session-memo').value}:null}));}
  function restoreDraft(){let d={};try{d=JSON.parse(localStorage.getItem(draftKey())||'{}')||{};}catch{}pending=d.pending||null;metadataRequest=d.metadataRequest||null;metadataDirty=!!d.memoDraft;if(d.memoDraft){$('session-title').value=d.memoDraft.title;$('session-memo').value=d.memoDraft.memo;}selected=Array.isArray(d.selected)?d.selected.filter(t=>typeof t.id==='string'&&typeof t.title==='string').slice(0,20):[];selectedQuestion=d.selectedQuestion?.key && Array.isArray(d.selectedQuestion.related_ids)?d.selectedQuestion:null;$('chat-text').value=d.text||'';agentRole=pending?.agent_role||(agentNames[d.agentRole]?d.agentRole:requestedRole);episodeRef=d.episodeRef||'';}
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
    const welcome=el('div',undefined,'chat-welcome');
    const profile=roleConversation[agentRole];welcome.append(el('h2',profile.title),el('p',profile.hint));
    const starters=el('div',undefined,'conversation-starters');
    for(const prompt of profile.prompts){const b=el('button',prompt);b.type='button';b.disabled=busy||!!pending;b.onclick=()=>{$('chat-text').value+=($('chat-text').value?'\n\n':'')+prompt;changedSelection();};starters.append(b);}welcome.append(starters);
    if(!['lumos','aipm'].includes(agentRole)||new URL(window.location.href).searchParams.get('embedded')==='1'){host.append(welcome);return;}
    if(!taskState||!loaded)welcome.append(el('p',taskError||'正在核对当前问题与已提交的答复…','muted'));
    else{
      const inbox=discussionQuestions(taskState,jobs,workspace);
      const cards=(questions,parent)=>{for(const q of questions){const b=el('button',undefined,'question-prompt');b.type='button';b.setAttribute('aria-pressed',String(selectedQuestion?.key===q.key));b.disabled=busy||!!pending;b.append(el('strong',q.title),el('span',q.text),el('small',q.timingReason+' · 点击回答'));b.onclick=()=>chooseQuestion(q);parent.append(b);}};
      cards(inbox.primary,welcome);
      if(!inbox.primary.length)welcome.append(el('p','当前没有需要立即回答的主线问题。可以搜索并选择你想讨论的事项。','muted'));

    }
    host.append(welcome);
  }
  async function loadTasks(){const current=++taskRead;try{const r=await fetch('/api/tasks'),data=await r.json();if(current!==taskRead)return;if(!r.ok)throw new Error();taskState=data;taskError='';}catch{if(current!==taskRead)return;taskState=null;taskError='任务与主线暂时读取失败，可直接写下名称和进展。';}signature='';render();if($('subject-picker').open)renderPicker();}
  function address(){const u=new URL(window.location.href);u.searchParams.set('workspace',workspace);u.searchParams.set('id',chatId);u.searchParams.set('role',agentRole);u.searchParams.delete('agent');u.searchParams.delete('episode');u.searchParams.delete('material');history.replaceState(null,'',u);try{localStorage.setItem('lumos.chat.active.'+agentRole+'.'+workspace,chatId);}catch{}}
  function controls(){
    restoreModel();
    const latest=chatTurns(jobs,chatId).at(-1),waiting=latest && ['pending','running','failed'].includes(latest.data.status);
    $('chat-text').readOnly=busy||!!pending||readOnly();
    $('chat-text').required=!selectedQuestion?.answer;
    $('send-chat').disabled=!loaded||!modelsReady||!enabled||busy||readOnly()||(!pending && (waiting||!answerText($('chat-text').value,selectedQuestion)));
    $('send-chat').textContent=pending?'重试确认':busy?'发送中…':'发送';
    $('chat-model').disabled=busy||!!pending||!modelsReady;
    $('role-heading').textContent=agentNames[agentRole]||'历史对话';
    $('role-description').textContent=typeof roleSpaces!=='undefined'?roleSpaces[agentRole]?.purpose||'混合历史保留原样':'';
    $('conversation-scope').textContent='资料范围：'+(workspace==='lumos'?'Lumos 仓库维护':'灵光')+(readOnly()?' · 只读历史':'');
    $('writing-label').textContent='写给 '+agentNames[agentRole];
    $('conversation').setAttribute('aria-label','与 '+agentNames[agentRole]+' 对话');
    $('chat-text').placeholder=roleConversation[agentRole].hint;
    $('choose-subjects').hidden=!['lumos','aipm'].includes(agentRole);
    const resource=$('role-resource');resource.hidden=['lumos','aipm'].includes(agentRole);resource.textContent=agentRole==='librarian'?'查找资料':'运行问题';resource.href=(agentRole==='librarian'?'/knowledge?role=librarian':'/agents?role=maintainer')+'&workspace='+workspace;
    $('episode-reference').textContent=episodeRef?'正在反馈一次执行：'+episodeRef:'';
    $('chat-workspace').disabled=busy;$('new-chat').disabled=busy;$('choose-subjects').disabled=busy||!!pending;
    const question=$('selected-question');question.replaceChildren();
    if(selectedQuestion){const copy=el('div',undefined,'selected-question-copy');copy.append(el('p','正在回答：'+selectedQuestion.text));if(selectedQuestion.answer)copy.append(el('p','已选：'+selectedQuestion.answer,'chosen-answer'));question.append(copy);const clear=el('button','取消选择');clear.type='button';clear.disabled=busy||!!pending;clear.onclick=()=>{selectedQuestion=null;changedSelection();};question.append(clear);}
    const picked=$('selected-tasks');picked.replaceChildren();
    for(const t of selected){const b=el('button',t.title+' ×','selected-task');b.type='button';b.disabled=busy||!!pending;b.setAttribute('aria-label','移除讨论对象：'+t.title);b.onclick=()=>chooseTask({id:t.id});picked.append(b);}
    $('chat-status').textContent=error||(readOnly()?'此对话保留只读。可查看原文，点击新对话继续。':'')||(pending?'上次发送结果未确认，重试会核对同一条消息，不会重复创建。':!loaded?'正在读取对话…':!enabled?'此空间尚未启用自主整理。':executor==='offline'?'Codex 执行器未运行；消息可保存，恢复后接续。':waiting?latest.data.status==='failed'?'本轮失败，原话已保留。请在消息下方重试。':'消息已保存，可离开页面；答复完成后会保留在此处。':'');
  }
  function render(){
    const groups=new Map(sessions.map(n=>[n.data.chat_id,n]));
    for(const n of jobs)if(n.data.chat_id && !n.data.chat_parent && !groups.has(n.data.chat_id))groups.set(n.data.chat_id,n);
    // Retain browser-only drafts from before the upgrade and new unsent conversations.
    for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i),prefix='lumos.chat.'+workspace+'.';if(!key?.startsWith(prefix))continue;
      const id=key.slice(prefix.length);if(!/^[a-f0-9]{32}$/.test(id)||groups.has(id))continue;
      try{const d=JSON.parse(localStorage.getItem(key));if(d?.text||d?.pending)groups.set(id,{data:{chat_id:id,title:'未发送草稿',agent_role:d.agentRole||'lumos',status:'draft'}});}catch{}}
    const entries=[...groups].filter(([id,n])=>(n.data.agent_role||'lumos')===agentRole||n.data.agent_role==='legacy');
    const nextListSignature=JSON.stringify(entries)+chatId+busy;
    if(nextListSignature!==listSignature){
      const list=$('chat-list');list.replaceChildren();
      for(const [id,first] of entries){const b=el('button',first.data.title,'chat-link');b.setAttribute('aria-current',String(id===chatId));b.disabled=busy;
        const latest=chatTurns(jobs,id).at(-1);b.append(el('small',first.data.status==='legacy'?'混合角色历史 · 只读':first.data.status==='closed'?'已结束':latest?.data.status==='running'?'正在处理':latest?.data.status==='failed'?'待重试':latest?'已保存对话':'尚未发送'));
        b.onclick=()=>selectChat(id);list.append(b);}
      if(!entries.length)list.append(el('p','还没有对话。可以直接写下第一件事，或新建一段有标题的对话。','muted'));
      listSignature=nextListSignature;
    }
    const turns=chatTurns(jobs,chatId),latest=turns.at(-1);
    const meta=currentSession();
    $('chat-title').textContent=meta?.data.title||turns[0]?.data.title||'从一件正在推进的事开始';
    const stamp=JSON.stringify(meta);if(stamp!==metaSignature&&!metadataDirty){$('session-title').value=meta?.data.title||turns[0]?.data.title||'';$('session-memo').value=meta?.data.memo||'';metaSignature=stamp;}
    $('save-session').disabled=!loaded||sessionBusy||readOnly();$('close-session').disabled=!meta||sessionBusy||meta.data.status==='legacy';$('close-session').textContent=meta?.data.status==='closed'?'重新打开对话':'结束这段对话';
    $('memo-sources').textContent=meta?.data.source_ids?.length?'来源引用：'+meta.data.source_ids.join('、'):'';
    $('recent-result').textContent=latest?.data.summary?'最近结果：'+latest.data.summary:'';
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
        const answer=el('div',undefined,'assistant-message');answer.append(el('p',agentNames[d.agent_role]||'Lumos','chat-author'));
        if(d.reply){const body=el('div',undefined,'reply-body');for(const block of replyBlocks(d.reply)){if(block.kind==='list'){const list=el('ul');for(const item of block.items)list.append(el('li',item));body.append(list);}else body.append(el('p',block.text));}answer.append(body);}
        const receipt=el('div',undefined,'chat-receipt');
        if(['pending','running','failed'].includes(d.status))receipt.append(el('p',chatReceipt(job),'response-state'));
        else if(d.lumos_report?.decision)receipt.append(el('p',d.lumos_report.decision.phase==='external'?'Lumos 外部协调 · 已保存':'Lumos 已决定 · 已保存本轮结果','response-state'));
        else if(d.lumos_report?.status==='received'&&d.agent_role!=='lumos')receipt.append(el('p',d.destinations?.length?'已保存 · 已同步 Lumos':'已同步 Lumos','response-state'));
        else if(d.destinations?.length)receipt.append(el('p','已保存本轮更新','response-state'));
        if(d.ops_report&&d.status==='failed'){
          receipt.append(el('p','已交 Ops · 原输入已保留','response-state'));
          const a=el('a','打开 Ops 报告','action-link');a.href='/agents?role=maintainer&workspace='+workspace+'&episode='+encodeURIComponent(job.id);receipt.append(a);
        }
        if(!d.reply&&d.summary)receipt.append(el('p',d.summary));
        for(const target of job.targets||[])if(['action','mainline'].includes(target.kind)){const a=el('a',target.title,'action-link');a.href=(target.kind==='action'?'/tasks?role=aipm&task=':'/?role=lumos&line=')+encodeURIComponent(target.id)+'&workspace='+workspace;receipt.append(a);}
        for(const [index,q] of (d.questions||[]).entries()){
          const last=(d.resolutions||[]).filter(r=>r.index===index).at(-1);
          if(last?.state==='resolved')continue;
          if(last?.state==='waiting'){receipt.append(el('p','等待后续结果：'+last.remaining,'response-state'));continue;}
          const remaining=last?.remaining||q;
          const key='question:'+job.id+':'+index;
          const submitted=jobs.find(n=>n.data.question_key===key||n.data.question_keys?.includes(key));
          if(submitted&&['pending','running','failed'].includes(submitted.data.status)){
            receipt.append(el('p',submitted.data.status==='failed'?'答复处理未完成 · 请重试已保存的那轮消息':'答复已提交 · 正在接续','response-state'));continue;
          }
          const options=(job.question_options||[]).find(g=>g.index===index)?.options||[];
          const choose=answer=>{selectedQuestion={key,title:'补充本轮信息',text:remaining,related_ids:job.data.related_ids||[],...(answer?{answer}:{})};changedSelection();};
          if(options.length){
            const group=el('section',undefined,'clarification');group.setAttribute('aria-label',remaining);
            group.append(el('p',remaining,'clarification-question'));
            const choices=el('div',undefined,'clarification-choices');choices.setAttribute('role','group');choices.setAttribute('aria-label','选择答复');
            for(const option of options){const b=el('button',option.text,'clarification-option');b.type='button';b.disabled=!option.available||busy||!!pending||readOnly();b.setAttribute('aria-pressed',String(selectedQuestion?.key===key&&selectedQuestion?.answer===option.text));b.onclick=()=>choose(option.text);choices.append(b);}
            const free=el('button','自由补充','answer-question');free.type='button';free.disabled=busy||!!pending||readOnly();free.onclick=()=>choose();choices.append(free);group.append(choices);
            group.append(el('p',options.some(o=>!o.available)?'部分选项的依据已变化，请直接补充当前情况。':'选好后可补充说明，点击发送才会处理。','clarification-help'));
            receipt.append(group);continue;
          }
          if(!d.reply)receipt.append(el('p',remaining));
          const b=el('button','补充答复'+(d.questions.length>1?' '+(index+1):''),'answer-question');b.type='button';b.disabled=busy||!!pending||readOnly();
          b.onclick=()=>choose();receipt.append(b);
        }
        if(d.error)receipt.append(el('p',d.error,'chat-failed'));
        if(job.id===latest.id && d.status==='failed'){const b=el('button','重试本轮');b.disabled=busy||!!pending;b.onclick=()=>send({request_id:uuid(),id:job.id,expected_revision:d.revision});receipt.append(b);}
        if(receipt.children.length)answer.append(receipt);turn.append(answer);host.append(turn);
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
      const notifyParent=finished&&jobs.length>0;
      sessions=data.conversations||[];
      const bound=currentSession()?.data.agent_role||data.intakes.find(n=>n.data.chat_id===chatId)?.data.agent_role;
      if(bound&&bound!=='legacy'){agentRole=bound;requestedRole=bound;address();window.dispatchEvent(new CustomEvent('lumos-role',{detail:agentRole}));}
      jobs=data.intakes;token=data.token;enabled=data.enabled;executor=data.executor;loaded=true;if(error.startsWith('对话读取失败：'))error='';render();if(finished)loadTasks();if(notifyParent&&url.searchParams.get('embedded')==='1')window.parent.postMessage({lumosChat:'saved'},window.location.origin);
    }catch(e){if(current!==generation)return;loaded=false;error='对话读取失败：'+e.message;controls();}
    if(current===generation)timer=setTimeout(refresh,4000);
  }
  async function selectChat(id,newWorkspace=workspace){
    if(busy)return;
    try{saveDraft();}catch(e){error='草稿无法保存在此浏览器，请先复制正文。';controls();return;}
    workspace=newWorkspace;chatId=id;generation++;clearTimeout(timer);signature='';metaSignature='';metadataDirty=false;error='';restoreDraft();address();
    $('chat-workspace').value=workspace;loaded=false;jobs=[];sessions=[];render();loadTasks();await refresh();$('chat-text').focus();
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
    if(url.searchParams.get('material')&&!$('chat-text').value)$('chat-text').value='请查阅项目文件“'+url.searchParams.get('material')+'”，说明主要内容和未解析的部分。只查阅，不登记或修改任务。';
  }
  try{saveDraft();address();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}
  $('new-chat').onclick=()=>{if(busy)return;$('new-workspace').value=workspace;$('new-title').value='';$('new-error').textContent='';$('new-conversation-title').textContent='与 '+agentNames[agentRole]+' 新建对话';$('new-conversation').showModal();$('new-title').focus();};
  $('cancel-new').onclick=()=>$('new-conversation').close();
  dismissOnBackdrop($('new-conversation'));
  async function postSession(request){const r=await fetch('/api/conversations',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(request)}),data=await r.json();if(!r.ok){const error=new Error(data.error||'保存失败');error.status=r.status;throw error;}return data.conversation;}
  $('new-conversation-form').onsubmit=async e=>{e.preventDefault();if(sessionBusy)return;sessionBusy=true;$('create-conversation').disabled=true;
    try{saveDraft();creationRequest ||= {request_id:uuid(),chat_id:uuid(),agent_role:agentRole,workspace:$('new-workspace').value,title:$('new-title').value.trim(),expected_revision:0};
      const n=await postSession(creationRequest);creationRequest=null;$('new-conversation').close();await selectChat(n.data.chat_id,n.data.workspace);
    }catch(e){if(e.status>=400&&e.status<500)creationRequest=null;$('new-error').textContent=e.message+(creationRequest?'；重试将核对同一次创建。':'；请修改后重试。');}finally{sessionBusy=false;$('create-conversation').disabled=false;render();}};
  $('session-title').oninput=$('session-memo').oninput=()=>{metadataDirty=true;try{saveDraft();}catch{$('session-status').textContent='无法保留备忘草稿，请复制正文后再切换。';}};
  async function saveMeta(status){if(sessionBusy)return;sessionBusy=true;controls();const old=currentSession();
    try{metadataRequest ||= {request_id:uuid(),chat_id:chatId,agent_role:old?.data.agent_role||agentRole,workspace,title:$('session-title').value.trim()||$('chat-title').textContent,memo:$('session-memo').value,expected_revision:old?.data.revision||0,...(status?{status}:{})};
      saveDraft();const n=await postSession(metadataRequest);metadataRequest=null;sessions=[n,...sessions.filter(s=>s.id!==n.id)];metadataDirty=false;saveDraft();$('session-status').textContent='已保存；备忘随本对话接续。';render();
    }catch(e){if(e.status>=400&&e.status<500){metadataRequest=null;await refresh();$('session-status').textContent=e.message+'；最新已保存备忘：'+(currentSession()?.data.memo||'（空）')+'。当前输入保留，请核对后再次保存。';}else{$('session-status').textContent=e.message+'；保留原请求，请重试保存。';}try{saveDraft();}catch{}}finally{sessionBusy=false;render();}}
  $('save-session').onclick=()=>saveMeta();$('close-session').onclick=()=>saveMeta(currentSession()?.data.status==='closed'?'active':'closed');
  $('chat-text').oninput=()=>{error='';try{saveDraft();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}controls();};
  $('chat-text').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}};
  $('chat-form').onsubmit=e=>{e.preventDefault();if($('send-chat').disabled)return;const text=answerText($('chat-text').value,selectedQuestion);send(pending||{request_id:uuid(),workspace,chat_id:chatId,chat_parent:chatTurns(jobs,chatId).at(-1)?.id||'',model:$('chat-model').value,agent_role:agentRole,...(episodeRef?{episode_ref:episodeRef}:{}),text,title:text.slice(0,60),related_ids:[...new Set([...selected.map(t=>t.id),...(selectedQuestion?.related_ids||[])])],...(selectedQuestion?{question_key:selectedQuestion.key,question_keys:selectedQuestion.question_keys||[selectedQuestion.key],question_text:selectedQuestion.question_keys?.length>1?selectedQuestion.title+' · 合并跟进':selectedQuestion.text}:{})});};
  function setExpanded(value){expanded=value;$('conversation').setAttribute('data-writing',value?'expanded':'normal');$('expand-writing').setAttribute('aria-expanded',String(value));$('expand-writing').textContent=value?'收起书写':'展开书写';}
  $('choose-subjects').onclick=()=>{$('subject-search').value='';$('subject-type').value='all';renderPicker();$('subject-picker').showModal();$('subject-search').focus();loadTasks();};
  $('subject-search').oninput=renderPicker;$('subject-type').onchange=renderPicker;
  $('close-subject-picker').onclick=()=>$('subject-picker').close();$('subject-picker').onclose=()=>{$('chat-text').focus();};
  dismissOnBackdrop($('subject-picker'));
  $('expand-writing').onclick=()=>{setExpanded(!expanded);$('chat-text').focus();};
  const modelKey=()=> 'lumos.chat.model.'+agentRole;
  function restoreModel(){
    if(!modelsReady)return;
    const signature=JSON.stringify([agentRole,pending?.model]);
    if(modelSignature===signature)return;
    let selected='';
    try{selected=localStorage.getItem(modelKey());if(selected===null){selected=localStorage.getItem('lumos.chat.model')||'';localStorage.setItem(modelKey(),selected);}}catch{selected='';}
    selected=pending?.model??selected;
    const options=[{id:'',name:'默认模型'},...availableModels];
    if(selected&&!options.some(m=>m.id===selected))options.push({id:selected,name:selected+'（未在当前列表中）'});
    $('chat-model').replaceChildren();
    for(const m of options){const o=el('option',m.name);o.value=m.id;$('chat-model').append(o);}
    $('chat-model').value=selected;modelSignature=signature;
  }
  $('chat-model').onchange=()=>{try{localStorage.setItem(modelKey(),$('chat-model').value);}catch{error='模型选择无法保存在此浏览器，刷新后可能需要重新选择。';controls();}};
  async function models(){try{const r=await fetch('/api/codex-models'),data=await r.json();if(!r.ok)throw new Error();availableModels=data.models;if(!data.models.length)$('model-help').textContent='暂未读取到本机模型列表；保留已选模型，实际可用性以调用结果为准。';}catch{$('model-help').textContent='模型列表读取失败；保留已选模型，实际可用性以调用结果为准。';}finally{modelsReady=true;controls();}}
  $('manage-conversation').onclick=()=>$('conversation-management').showModal();
  $('close-management').onclick=()=>$('conversation-management').close();
  dismissOnBackdrop($('conversation-management'));
  models();loadTasks();refresh();
}
