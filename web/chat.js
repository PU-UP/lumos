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
if(typeof module!=='undefined')module.exports={chatTurns,chatReceipt};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const uuid=()=>crypto.randomUUID().replaceAll('-','');
  const url=new URL(window.location.href);
  let workspace=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang',chatId=url.searchParams.get('id');
  try{chatId ||= localStorage.getItem('lumos.chat.active.'+workspace);}catch{}chatId ||= uuid();
  let jobs=[],token='',enabled=false,executor='',loaded=false,busy=false,pending=null,timer,generation=0,signature='',listSignature='',error='';
  const draftKey=()=>`lumos.chat.${workspace}.${chatId}`;
  function saveDraft(){localStorage.setItem(draftKey(),JSON.stringify({text:$('chat-text').value,pending}));}
  function restoreDraft(){let d={};try{d=JSON.parse(localStorage.getItem(draftKey())||'{}')||{};}catch{}pending=d.pending||null;$('chat-text').value=d.text||'';}
  function address(){const u=new URL(window.location.href);u.searchParams.set('workspace',workspace);u.searchParams.set('id',chatId);history.replaceState(null,'',u);try{localStorage.setItem('lumos.chat.active.'+workspace,chatId);}catch{}}
  function controls(){
    const latest=chatTurns(jobs,chatId).at(-1),waiting=latest && ['pending','running','failed'].includes(latest.data.status);
    $('chat-text').readOnly=busy||!!pending;
    $('send-chat').disabled=!loaded||!enabled||busy||(!pending && (waiting||!$('chat-text').value.trim()));
    $('send-chat').textContent=pending?'重试确认':busy?'发送中…':'发送';
    $('chat-model').disabled=busy||!!pending;
    $('chat-workspace').disabled=busy;$('new-chat').disabled=busy;
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
      if(!turns.length){const welcome=el('div',undefined,'chat-welcome');welcome.append(el('h2','讨论清楚，进展也留下来。'),el('p','可以询问近期重点、梳理方案，或直接补充某项任务的进展。提到任务名称或 T-编号，Lumos 会结合当前记录接续。'));host.append(welcome);}
      for(const job of turns){
        const d=job.data,turn=el('article',undefined,'chat-turn'),user=el('div',undefined,'user-message');
        user.append(el('p','王牧楠 · '+new Date(d.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}),'chat-author'),el('p',d.text,'chat-text'));turn.append(user);
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
      if(bottom||!signature)host.scrollTop=host.scrollHeight;
      signature=nextSignature;
    }
    controls();
  }
  async function refresh(){
    clearTimeout(timer);const current=generation;
    try{const response=await fetch('/api/intakes?workspace='+workspace),data=await response.json();if(current!==generation)return;if(!response.ok)throw new Error(data.error||'读取失败');
      jobs=data.intakes;token=data.token;enabled=data.enabled;executor=data.executor;loaded=true;if(error.startsWith('对话读取失败：'))error='';render();
    }catch(e){if(current!==generation)return;loaded=false;error='对话读取失败：'+e.message;controls();}
    if(current===generation)timer=setTimeout(refresh,4000);
  }
  async function selectChat(id,newWorkspace=workspace){
    if(busy)return;
    try{saveDraft();}catch(e){error='草稿无法保存在此浏览器，请先复制正文。';controls();return;}
    workspace=newWorkspace;chatId=id;generation++;clearTimeout(timer);signature='';error='';restoreDraft();address();
    $('chat-workspace').value=workspace;loaded=false;jobs=[];render();await refresh();$('chat-text').focus();
  }
  async function send(request){
    if(busy)return;busy=true;error='';pending ||= request;generation++;clearTimeout(timer);
    try{
      saveDraft();controls();
      const r=await fetch('/api/intakes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),data=await r.json();
      if(!r.ok){if(r.status>=400 && r.status<500){pending=null;saveDraft();}throw new Error(data.error||'发送失败');}
      pending=null;$('chat-text').value='';saveDraft();signature='';
      jobs=[data.intake,...jobs.filter(n=>n.id!==data.intake.id)];render();await refresh();
    }catch(e){error=e.message;timer=setTimeout(refresh,4000);}finally{busy=false;signature='';render();$('chat-text').focus();}
  }
  $('chat-workspace').value=workspace;restoreDraft();address();
  $('new-chat').onclick=()=>chatTurns(jobs,chatId).length?selectChat(uuid()):$('chat-text').focus();
  $('chat-workspace').onchange=()=>{const space=$('chat-workspace').value;let id;try{id=localStorage.getItem('lumos.chat.active.'+space);}catch{}return selectChat(id||uuid(),space);};
  $('chat-text').oninput=()=>{error='';try{saveDraft();}catch{error='浏览器无法保留草稿，请勿关闭页面。';}controls();};
  $('chat-text').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();$('chat-form').requestSubmit();}};
  $('chat-form').onsubmit=e=>{e.preventDefault();if($('send-chat').disabled)return;const text=$('chat-text').value.trim();send(pending||{request_id:uuid(),workspace,chat_id:chatId,chat_parent:chatTurns(jobs,chatId).at(-1)?.id||'',model:$('chat-model').value,text,title:text.slice(0,60)});};
  $('chat-model').onchange=()=>{try{localStorage.setItem('lumos.chat.model',$('chat-model').value);}catch{}};
  async function models(){try{const r=await fetch('/api/codex-models'),data=await r.json();if(!r.ok)throw new Error();for(const m of data.models){const o=el('option',m.name);o.value=m.id;$('chat-model').append(o);}let selected='';try{selected=localStorage.getItem('lumos.chat.model')||'';}catch{}if(data.models.some(m=>m.id===selected))$('chat-model').value=selected;if(!data.models.length)$('model-help').textContent='暂未读取到本机模型列表，将使用 Codex 默认模型。';}catch{$('model-help').textContent='模型列表读取失败，将使用 Codex 默认模型。';}}
  models();refresh();
}
