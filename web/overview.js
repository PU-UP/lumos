'use strict';
const {mainlineLabels,isOpenTask,deliveryDate,targetDate,deliverySort,mainlineSort,taskQuestionTiming,managementModel,milestoneTasks,matchesTask,questionInbox}=typeof module!=='undefined'?require('./work-model.js'):window.LumosWorkModel;
const answerStates={pending:'已收到 · 等待整理',running:'正在整理',done:'已整理 · 结果已保存',needs_review:'已整理 · 有待确认项',failed:'整理失败 · 可重试',obsolete:'原记录已更新 · 需重新核对'};
function briefItems(model,inbox,history=[...(inbox.latest?.values()||[])]){
  const seen=new Set(),questions=[...inbox.primary,...inbox.rest];
  const items=[...model.entries.map(e=>({id:e.line.id,title:e.line.data.title,line:e.line,tasks:e.tasks.filter(isOpenTask)})),
    ...model.independent.filter(isOpenTask).map(t=>({id:t.id,title:t.data.text,tasks:[t]}))];
  for(const item of items)item.questions=questions.filter(q=>{if(seen.has(q.key))return false;const match=q.line?.id===item.id||q.tasks?.some(t=>item.tasks.some(v=>v.id===t.id));if(match)seen.add(q.key);return match;});
  for(const q of questions)if(!seen.has(q.key)){items.push({id:q.key,title:q.title===q.text?'需要你确认':q.title,tasks:[],questions:[q]});seen.add(q.key);}
  for(const item of items)item.receipts=[];
  for(const job of new Map(history.map(j=>[j.id,j])).values()){
    const exact=[...(job.data.related_ids||[]),...(job.data.destinations||[]),...(job.targets||[]).map(n=>n.id)].filter(id=>model.excludedIds?.includes(id)||model.tasks?.some(t=>t.id===id));
    if(exact.length && exact.every(id=>model.excludedIds?.includes(id)))continue;
    if(!exact.length&&model.excludedQuestionKeys?.includes(job.data.question_key))continue;
    const targets=(job.targets||[]).filter(t=>['action','mainline'].includes(t.kind)),refs=[...targets.map(t=>t.id),...(job.data.destinations||[])],keys=[job.data.question_key,...(job.data.question_keys||[])];
    const match=ids=>items.find(i=>ids.includes(i.id))||items.find(i=>i.tasks.some(t=>ids.includes(t.id)));
    let item=match(job.data.related_ids||[])||items.find(i=>i.questions.some(q=>keys.includes(q.key)))||match(refs);
    if(!item){item={id:job.id,title:job.subjects?.map(s=>s.title).join('、')||targets.map(t=>t.title).join('、')||job.data.title,tasks:[],questions:[],receipts:[]};items.push(item);}
    item.receipts.push(job);
  }
  for(const item of items)item.receipts.sort((a,b)=>(b.data.created_at||'').localeCompare(a.data.created_at||''));
  // Results remain attached to the item after the question is resolved.
  const rank=item=>item.questions.length?2:item.receipts.length?1:0;
  return items.sort((a,b)=>rank(b)-rank(a));
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
if (typeof module !== 'undefined') module.exports = {managementModel, milestoneTasks, deliveryDate, targetDate, matchesTask, submission, questionInbox, taskQuestionTiming,briefItems};

if (typeof document !== 'undefined') {
  const $ = id => document.getElementById(id);
  const el = (tag, text, cls) => {const n=document.createElement(tag); if(text !== undefined)n.textContent=text; if(cls)n.className=cls; return n;};
  const deliveryView = window.location.pathname === '/delivery' || new URLSearchParams(window.location.search).get('view') === 'delivery';
  const preferencesKey = 'lumos.management.v1';
  let state, model, pinned=[], detailRequest=0, attentionOpen=true, writing=false;
  let briefFilter='all';
  if(window.LumosRoleUI&&!deliveryView){const filters=el('div',undefined,'brief-filters');filters.id='brief-filters';filters.setAttribute('aria-label','按处理状态筛选');$('attention-items').before(filters);}
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
  const linkedWorkspace=new URLSearchParams(window.location.search).get('workspace');
  if(['lingguang','lumos'].includes(linkedWorkspace))$('workspace').value=linkedWorkspace;
  $('attention').open=window.LumosRoleUI&&!deliveryView?true:attentionOpen;
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
  let feedbackSender,feedbackWorkspace,activeQuestion=null,answerOpener=null,receipts=[],receiptState='loading',executor='',feedbackError='',generalReceipt=null;
  const feedbackKey=()=> 'lumos.feedback.'+feedbackWorkspace+(activeQuestion?'.'+encodeURIComponent(activeQuestion.key):'');
  function stashFeedback(){
    try{localStorage.setItem(feedbackKey(),JSON.stringify({text:$('feedback-text').value,target:$('feedback-target').value,pending:feedbackSender?.pending}));}
    catch{feedbackError='浏览器无法保存草稿，请保持页面打开或复制正文。';$('feedback-status').textContent=feedbackError;}
  }
  function restoreFeedback(){
    feedbackWorkspace=$('workspace').value;let draft={};
    try{draft=JSON.parse(localStorage.getItem(feedbackKey()))||{};}catch{}
    $('feedback-text').value=draft.text||'';
    $('feedback-target').value=activeQuestion?.line?.id || activeQuestion?.tasks[0]?.id || draft.target || '';
    feedbackSender=submission(r=>post('/api/intakes',r),draft.pending||null);
  }
  function latestAnswer(){return activeQuestion?questionInbox([],receipts,feedbackWorkspace).latest.get(activeQuestion.key):receipts.find(n=>n.id===generalReceipt);}
  function answerStatus(job){
    if(job.data.status==='failed' && job.data.error)return '整理未保存：'+(job.data.error==='Invalid task fields'?'方案包含不允许修改的任务字段；原答复已保留，需修正后重试。':job.data.error);
    return answerStates[job.data.status]||'状态待核对';
  }
  function updateAnswerStatus(){
    if(!$('answer-dialog').open)return;
    const job=latestAnswer(),busy=job && ['pending','running'].includes(job.data.status),pending=feedbackSender?.pending;
    $('feedback-target').disabled=!!activeQuestion || writing || !!pending;
    $('feedback-text').readOnly=writing || !!pending || !!busy;
    $('feedback-submit').disabled=writing || !state.writable || (!!busy && !pending);
    $('close-answer').disabled=writing;
    $('feedback-submit').textContent=pending?'重试提交':job?'提交补充':'提交答复';
    $('feedback-status').textContent=feedbackError || (pending?'上次提交结果未确认，请重试核对同一份答复。':receiptState==='error'?'暂时无法读取处理状态；正文保留，可刷新重试。':busy?(['offline','waiting','stopped'].includes(executor)?'答复已保存；Lumos执行器未运行，恢复后接续。':answerStates[job.data.status]):'填写已知情况即可，Lumos会接续任务和安排。');
    const host=$('answer-receipt');host.replaceChildren();
    if(activeQuestion?.answers?.length){
      const history=fold('原问题与答复历史',host,'question-history:'+activeQuestion.key);
      history.append(el('p',activeQuestion.original_question));
      for(const answer of activeQuestion.answers){
        history.append(el('p',answer.at+' · '+answer.answer),el('p','答复原文：'+answer.excerpt));
        if(answer.remaining)history.append(el('p','当时剩余问题：'+answer.remaining));
      }
    }
    if(job){
      host.append(el('strong',answerStatus(job)));
      if(window.LumosModels)host.append(el('p','本轮模型：'+window.LumosModels.receipt(job.data),'muted'));
      if(job.data.summary)host.append(el('p',job.data.summary));
      if(['done','needs_review'].includes(job.data.status)){
        const remaining=model.questions.find(q=>q.key===job.data.question_key);
        if(remaining)host.append(el('p',remaining.answer_state==='pending'?'已答内容已记录；当前只需补充页面显示的剩余问题。':remaining.answer_state?remaining.timingReason:'已收到答复，剩余事项待Lumos接续；不要求立即补答。','muted'));
      }
      if(job.data.error)host.append(el('p',job.data.error));
      const original=fold('已提交的答复',host,'answer:'+job.id);original.append(el('p',job.data.text));
      if(job.data.status==='failed'){
        const retry=el('button','重试Lumos处理');retry.type='button';retry.disabled=writing || !!pending;
        retry.onclick=()=>sendFeedback({request_id:crypto.randomUUID().replaceAll('-',''),id:job.id,expected_revision:job.data.revision});host.append(retry);
      }
    }
  }
  function openFeedback(question=null,opener=null){
    activeQuestion=question;answerOpener=opener;feedbackError='';generalReceipt=null;restoreFeedback();
    $('answer-title').textContent=question?.title||'补充进展';
    $('answer-label').textContent=(question?'你的答复':'补充进展或处理意见')+(window.LumosModels?' · '+(window.LumosModels.get('lumos')||'Codex 默认模型'):'');
    $('answer-question').textContent=question?.text||'直接写下最新情况、判断或希望如何推进。';
    $('feedback-target').parentElement.hidden=!!question;
    $('answer-dialog').showModal();updateAnswerStatus();$('feedback-text').focus();
  }
  $('open-feedback').onclick=event=>openFeedback(null,event.currentTarget);
  $('close-answer').onclick=()=>$('answer-dialog').close();
  for(const id of ['answer-dialog','mainline-detail'])dismissOnBackdrop($(id));
  $('answer-dialog').addEventListener('cancel',event=>{if(writing)event.preventDefault();});
  $('answer-dialog').addEventListener('close',()=>{stashFeedback();(answerOpener?.isConnected?answerOpener:$('open-feedback')).focus();});
  $('feedback-text').oninput=stashFeedback;$('feedback-target').onchange=stashFeedback;
  function watchAnswers(){
    const workspace=$('workspace').value;
    window.LumosIntake?.watch($('intake-list'),workspace,null,load,data=>{
      if(workspace!==$('workspace').value)return;
      receiptState=data?'ready':'error';if(data){receipts=data.intakes;executor=data.executor;}
      renderQuestions();updateAnswerStatus();
    });
  }
  async function sendFeedback(request,submittedText){
    if(writing || !state?.writable)return;
    feedbackError='';setWriting(true);updateAnswerStatus();$('feedback-status').textContent='正在提交…';
    try{
      const result=await feedbackSender.send(request,stashFeedback);
      if(submittedText!==undefined && $('feedback-text').value.trim()===submittedText)$('feedback-text').value='';
      stashFeedback();
      if(result?.intake){receipts=[result.intake,...receipts.filter(n=>n.id!==result.intake.id)];receiptState='ready';if(!activeQuestion)generalReceipt=result.intake.id;}
      $('answer-notice').textContent='答复已保存。'+(answerStates[result?.intake?.data.status]||'可在答复记录中查看自动整理结果')+'；无需等待整理完成。';
      if(!activeQuestion)$('intake-panel').open=true;
      $('answer-dialog').close();
      renderQuestions();watchAnswers();
    }catch(e){feedbackError='未能确认提交：'+e.message+' 正文已保留，请重试核对。';}
    finally{setWriting(false);updateAnswerStatus();}
  }
  $('feedback-form').onsubmit=async event=>{
    event.preventDefault();if(writing || !state?.writable)return;
    const text=$('feedback-text').value.trim();if(!text && !feedbackSender.pending){$('feedback-status').textContent='请先填写答复。';$('feedback-text').focus();return;}
    const target=$('feedback-target').value;
    await window.LumosModels?.ready;
    if(!feedbackSender.pending&&window.LumosModels?.error){feedbackError=window.LumosModels.error;updateAnswerStatus();return;}
    const request=feedbackSender.pending||{request_id:crypto.randomUUID().replaceAll('-',''),workspace:feedbackWorkspace,...(window.LumosModels?{model:window.LumosModels.get('lumos')}:{}) ,
      text:activeQuestion?activeQuestion.text+'\n\n王牧楠答复：\n'+text:text,title:activeQuestion?.title.slice(0,300)||'主线页反馈',related_ids:target?[target]:[],...(activeQuestion?{question_key:activeQuestion.key,question_keys:activeQuestion.question_keys||[activeQuestion.key],question_text:activeQuestion.question_keys?.length>1?activeQuestion.title+' · 合并跟进':activeQuestion.text}:{})};
    await sendFeedback(request,request.id?undefined:text);
  };
  function renderQuestions(){
    if(!model)return;
    const inbox=questionInbox(model.questions,receipts,$('workspace').value),host=$('attention-items');host.replaceChildren();
    if(window.LumosRoleUI&&!deliveryView){
      const query=$('search').value.trim().toLowerCase();
      const all=briefItems(model,inbox,receipts.filter(j=>j.data.workspace===$('workspace').value&&j.data.question_key)),category=item=>item.questions.length?'answer':item.receipts.length&&['pending','running','failed'].includes(item.receipts[0].data.status)?'working':item.receipts.length?'updated':'other';
      const filters=$('brief-filters');
      if(filters){filters.replaceChildren();for(const [value,label] of [['all','全部'],['answer','待我答复'],['working','处理中 / 需重试'],['updated','已整理']]){const button=el('button',label+' '+(value==='all'?all.length:all.filter(i=>category(i)===value).length));button.setAttribute('aria-pressed',String(briefFilter===value));button.onclick=()=>{briefFilter=value;renderQuestions();};filters.append(button);}}
      const items=all.filter(item=>(briefFilter==='all'||category(item)===briefFilter)&&(!query||[item.title,...item.tasks.map(t=>[t.short_id,t.data.text,t.data.progress].join(' ')),...item.questions.map(q=>q.text),...item.receipts.map(j=>j.data.text+' '+j.data.summary)].join(' ').toLowerCase().includes(query)));
      $('attention-count').textContent='';
      for(const item of items){
        const row=el('article',undefined,'brief-item'),head=el('div',undefined,'brief-heading');
        const title=item.line?lineButton(item.line,item.title,'brief-title'):item.tasks.length?taskLink(item.tasks[0]):el('h3',item.title);
        if(item.tasks.length&&!item.line)title.replaceChildren(el('strong',item.title));
        head.append(title);if(item.questions.length)head.append(el('span','需要你答复','brief-state'));else if(item.receipts.length)head.append(el('span',answerStates[item.receipts[0].data.status]||'状态待核对','brief-state'));row.append(head);
        const next=[...item.tasks].sort(deliverySort).find(targetDate),follow=item.tasks.map(t=>t.data.follow_up).filter(Boolean).sort()[0];
        const facts=[item.line?item.tasks.length+' 项任务':item.tasks.length?item.tasks[0].data.owner||'负责人待确定':'',next?'交付 '+targetDate(next):'',follow?'跟进 '+follow:''].filter(Boolean);
        if(facts.length)row.append(el('p',facts.join(' · '),'brief-meta'));
        if(!item.questions.length&&!item.receipts.length){const d=item.line?.data||item.tasks[0]?.data;const text=d?.risk||d?.next_step||d?.progress||d?.summary;if(text)row.append(el('p',text,'brief-description'));}
        for(const q of item.questions){const group=el('div',undefined,'brief-question'),answer=el('button','答复');group.append(el('p',q.text));answer.onclick=()=>openFeedback(q,answer);group.append(answer);row.append(group);}
        if(item.receipts.length){
          const job=item.receipts[0],receipt=el('div',undefined,'brief-receipt'),view=el('button','答复与结果'+(item.receipts.length>1?' · '+item.receipts.length:''));
          if(!item.questions.length)receipt.append(el('p',job.data.summary||(['pending','running'].includes(job.data.status)?'你的答复已保存，处理结果会留在这里。':job.data.error||'答复已保留，可打开查看。'),'brief-description'));
          receipt.append(el('p',(job.data.updated_at?new Date(job.data.updated_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · ':'')+(window.LumosModels?.receipt(job.data)||'默认模型'),'brief-meta'));
          view.onclick=()=>openReceipts(item);receipt.append(view);row.append(receipt);
        }
        host.append(row);
      }
      if(!items.length)host.append(el('p',query?'没有匹配事项。':'目前没有待推进的事项，可以直接和 Lumos 聊。','attention-empty'));
      const progress=$('answer-progress');progress.replaceChildren();
      if(receiptState==='error')progress.append(el('p','答复状态读取失败，正在重试；已写内容保留。','muted'));
      return;
    }
    $('attention-count').textContent=inbox.primary.length?'本次 '+inbox.primary.length+' 件':'';
    if(!inbox.primary.length)host.append(el('p','当前没有需要立即回答的问题。后续事项按跟进日再出现。','attention-empty'));
    const add=(question,parent)=>{
      const row=el('article',undefined,'attention-item'),heading=el('div',undefined,'question-heading');
      heading.append(el('h3',question.title),el('span',question.needsAnswer===false?'等待后续跟进':question.answer_state==='pending'?'剩余待答':question.answer_state==='waiting'?'后续核对':'当前待答','answer-state'));
      row.append(heading,el('p',question.text,'question-preview'),el('p',question.timingReason,'question-timing'));
      const answer=el('button','打开回答','answer-button');answer.onclick=()=>openFeedback(question,answer);row.append(answer);parent.append(row);
    };
    for(const q of inbox.primary)add(q,host);
    if(inbox.rest.length){const more=fold('其他当前问题 · '+inbox.rest.length,host,'questions:rest');for(const q of inbox.rest)add(q,more);}
    if(inbox.later.length){const later=fold('后续再跟进 · '+inbox.later.length+'（无需现在回答）',host,'questions:later');for(const q of inbox.later)add(q,later);}
    const progress=$('answer-progress');progress.replaceChildren();
    if(receiptState==='error')progress.append(el('p','处理状态读取失败，正在重试；请勿重复提交。','muted'));
    else if(receiptState==='loading')progress.append(el('p','正在核对已提交的答复…','muted'));
    if(inbox.latest.size){
      const tracked=[...new Map([...inbox.latest].map(([key,job])=>[job.id,[key,job]])).values()];
      const working=tracked.filter(([,job])=>['pending','running','failed'].includes(job.data.status)).length;
      const section=fold('答复处理进度 · '+tracked.length+(working?' · '+working+' 件待处理或重试':' · 处理回执可查看'),progress,'answers',working>0);
      for(const [key,job] of tracked){
        const row=el('div',undefined,'answer-progress-row');row.append(el('span',model.questions.find(q=>q.key===key)?.title || (job.data.title==='跨事项待确认' ? job.data.question_text || job.data.text.split('\n\n王牧楠答复：')[0] : job.data.title)),el('span',answerStatus(job),'answer-state'));
        const view=el('button','查看答复与结果');view.onclick=()=>openFeedback(model.questions.find(q=>q.key===key)||{key,title:job.data.title,text:'这份答复的原文与处理结果如下。可继续补充新情况。',tasks:[],line:job.data.related_ids?.length===1?model.entries.find(e=>e.line.id===job.data.related_ids[0])?.line:null},view);row.append(view);section.append(row);
      }
    }
  }
  function taskLink(task, progress=false) {
    const link=el('a',undefined,'task-link');
    link.href='/tasks?task='+encodeURIComponent(task.id)+'&return='+encodeURIComponent(window.location.pathname+window.location.search);
    if(window.LumosRoleUI)link.onclick=event=>{if(event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();openTask(task);};
    link.append(el('strong',task.data.text));
    const projects=model.entries.filter(e=>(e.line.data.milestone_ids||[]).includes(task.id)).map(e=>e.line.data.title);
    if(projects.length)link.append(el('span',projects.join(' / '),'task-meta'));
    if(task.data.priority==='P3')link.append(el('span','P3 · 非项目事务','task-meta'));
    const due=task.data.due==='long_term'?'长期':task.data.due || '未约定';
    const overdue=isOpenTask(task) && targetDate(task) && targetDate(task)<state.today;
    if(task.data.planned_due)link.append(el('span','当前计划交付 '+task.data.planned_due,'task-meta'));
    link.append(el('span', `${mainlineLabels[task.data.status]} · ${task.data.owner || '王牧楠'}${task.data.owner_basis==='agent'?'（Lumos安排）':''} · 原交付 ${due}${overdue?' · 当前计划需重新安排或确认关键结果':''}`, 'task-meta'));
    if(progress && task.data.progress) link.append(el('p',task.data.progress,'task-progress'));
    return link;
  }
  function fold(title, parent, key='', initiallyOpen=false) {
    if(window.LumosRoleUI){const necessary=initiallyOpen||/^(risk:|schedule:|questions:rest|delivery:past)|:tasks$/.test(key);return window.LumosRoleUI[necessary?'section':'panel'](title,parent);}
    const d=el('details');
    if(key)window.LumosDisclosure.remember(d,'overview:'+$('workspace').value+':'+key,initiallyOpen);
    d.append(el('summary',title));parent.append(d);return d;
  }
  function lineButton(line, text='查看主线', cls='details-button') {const b=el('button',text,cls);b.onclick=()=>openLine(line.id);return b;}
  function dateGroups(tasks, parent, key) {
    const dated=tasks.filter(targetDate);
    if(!tasks.length) parent.append(el('p','尚无当前阶段交付。','muted'));
    for(const day of [...new Set(dated.map(targetDate))].sort()) {
      const section=el('div',undefined,'delivery-group');section.append(el('h3',day,'delivery-date'));
      for(const t of dated.filter(t=>targetDate(t)===day))section.append(taskLink(t));
      parent.append(section);
    }
    for(const [label,items] of [['长期',tasks.filter(t=>t.data.due==='long_term'&&!targetDate(t))],['未约定交付时间',tasks.filter(t=>!t.data.due&&!targetDate(t))]]) {
      if(items.length){const d=fold(label+' · '+items.length,parent,key+':'+label);d.className='delivery-extra';for(const t of items)d.append(taskLink(t));}
    }
  }
  function render() {
    model=managementModel(state,$('workspace').value);
    for(const id of ['attention','intake-panel','independent'])window.LumosDisclosure.remember($(id),'overview:'+$('workspace').value+':'+id,id==='attention'?attentionOpen:false);
    document.querySelector('.attention-toggle').textContent=$('attention').open?'收起':'展开';
    const target=$('feedback-target'),selected=target.value;target.replaceChildren(new Option('综合反馈',''));
    for(const e of model.entries)target.append(new Option(e.line.data.title,e.line.id));
    for(const issue of model.issues.filter(i=>!i.line))target.append(new Option(issue.title,issue.tasks[0].id));
    target.value=[...target.options].some(o=>o.value===selected)?selected:'';
    if(feedbackWorkspace!==$('workspace').value)restoreFeedback();
    $('feedback-submit').disabled=!state.writable;
    const query=$('search').value.trim();$('clear-search').hidden=!query;
    $('attention').hidden=deliveryView || !!query;
    renderQuestions();
    if(window.LumosRoleUI&&!deliveryView){
      $('attention').hidden=false;for(const id of ['near-term','mainlines','independent','search-results'])$(id).hidden=true;
      $('page-title').textContent='当前重点';$('page-description').textContent='';$('overview-date').textContent=state.today;
      $('sync').textContent='已读取最新记录';updateAnswerStatus();return;
    }
    const near=$('near-term');near.replaceChildren();near.hidden=deliveryView || !!query;
    near.append(el('h2','未来两周的阶段节点'),el('p',state.today+' 起 · 明确约定与Lumos目标分别标注','muted'));
    if(model.upcoming.length)dateGroups(model.upcoming,near,'upcoming');else near.append(el('p','暂无已排定的阶段节点；需要明确的关键时间会在问题中提出。','muted'));
    $('mainlines').replaceChildren();
    const entries=model.entries.filter(e=>!query || [e.line.data.title,e.line.data.summary,e.line.data.goal].join(' ').toLowerCase().includes(query.toLowerCase()) || (deliveryView?milestoneTasks(e):e.tasks).some(t=>matchesTask(t,query)));
    entries.sort((a,b)=>Number(pinned.includes(b.line.id))-Number(pinned.includes(a.line.id)) || mainlineSort(a.line,b.line));
    if(!entries.length)$('mainlines').append(el('p',query?(deliveryView?'没有匹配的主线或阶段成果。':'没有匹配的主线；相关任务见下方。'):'此空间尚未建立主线，独立事项仍可在下方查看。','empty-state'));
    if(deliveryView){
      const tasks=[...new Map(entries.flatMap(milestoneTasks).map(t=>[t.id,t])).values()];
      const overdue=tasks.filter(t=>targetDate(t) && targetDate(t)<state.today);
      if(overdue.length){const past=fold('当前计划已过，待Lumos处理 · '+overdue.length,$('mainlines'),'delivery:past');dateGroups(overdue,past,'delivery:past');}
      dateGroups(tasks.filter(t=>!targetDate(t) || targetDate(t)>=state.today),$('mainlines'),'delivery:current');
    }
    for(const entry of deliveryView?[]:entries) {
      const {line}=entry,d=line.data;
      const row=el('article',undefined,'mainline-row'),heading=el('div',undefined,'mainline-heading'),title=el('div',undefined,'mainline-title');
      const h=el('h2');h.append(lineButton(line,d.title,'title-button'));title.append(h,el('span',d.phase || '阶段待明确','phase'));
      if(d.priority)title.prepend(el('strong',d.priority,'phase'));
      const actions=el('div',undefined,'mainline-actions'),pin=el('button',pinned.includes(line.id)?'已置顶':'置顶','pin');
      pin.setAttribute('aria-pressed',String(pinned.includes(line.id)));pin.setAttribute('aria-label',d.title+' · 置顶');
      pin.onclick=()=>{pinned=pinned.includes(line.id)?pinned.filter(i=>i!==line.id):[...pinned,line.id];remember();render();};
      actions.append(pin,lineButton(line));heading.append(title,actions);row.append(heading);
      row.append(el('p',d.summary,'mainline-summary'));
      const action=el('div',undefined,'mainline-action');action.append(el('h3','接下来'),el('p',d.next_step || 'Lumos待明确下一步'));row.append(action);
      if(d.risk){const risk=fold('风险与待验证',row,'risk:'+line.id);risk.append(el('p',d.risk,'mainline-risk'));}
      const meta=el('div',undefined,'mainline-meta'),next=milestoneTasks(entry).filter(targetDate)[0];
      if(next){const label=deliveryDate(next)?(deliveryDate(next)<state.today?'待核对交付':'下一交付'):'Lumos目标';const a=el('a',`${label}：${targetDate(next)} · ${next.data.text}`);a.href='/tasks?task='+encodeURIComponent(next.id)+'&return='+encodeURIComponent('/?line='+line.id);meta.append(a);}
      else meta.append(el('span','阶段节点由Lumos接续安排'));
      meta.append(el('span','摘要依据 '+(d.as_of || '日期未记录')));row.append(meta);const schedule=fold('跟进安排',row,'schedule:'+line.id);schedule.append(reviewControl(line));
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
    if(past.length){const closed=fold('已结束独立事项 · '+past.length,$('independent-items'),'independent:past');for(const t of past)closed.append(taskLink(t));}
    $('overview-date').textContent=state.today;
    $('sync').textContent='记录日期 '+state.today+' · 已读取最新版本';
    updateAnswerStatus();
  }
  async function read(url){const r=await fetch(url);const data=await r.json();if(!r.ok)throw new Error(data.error||'读取失败');return data;}
  async function load() {
    $('refresh').disabled=true;$('message').textContent='正在读取……';
    try {
      const fresh=await read('/api/tasks');
      if(!Array.isArray(fresh.mainlines))throw new Error('当前服务尚未加载主线功能，请重启 Lumos 服务后刷新。');
      state=fresh;render(); watchAnswers();
      $('message').textContent=state.integrity?.drafts_or_missing_working_copies?.length?'存在未吸收的工作文档改动，当前展示正式保存记录。':'';
      const params=new URLSearchParams(window.location.search);
      const question=model.questions.find(q=>q.key===params.get('question'));
      if(question && !$('answer-dialog').open){
        openFeedback(question);
        const url=new URL(window.location.href);url.searchParams.delete('question');history.replaceState(null,'',url);
      }
      const id=params.get('line');
      if(id && !$('mainline-detail').open && model.entries.some(e=>e.line.id===id))await openLine(id);
    }catch(e){$('message').textContent='未能刷新：'+e.message+(state?'。下方仍为上次读取的内容。':'');}
    finally{$('refresh').disabled=writing;}
  }
  const detailTrail=[];
  const backDetail=el('button','返回上一层');backDetail.type='button';backDetail.hidden=true;
  if(window.LumosRoleUI){$('close-detail').before(backDetail);window.LumosRoleUI.resizable($('mainline-detail'));}
  backDetail.onclick=()=>{const previous=detailTrail.pop();if(!previous)return;detailRequest++;$('detail-title').textContent=previous.title;$('detail-content').replaceChildren(...previous.nodes);$('detail-content').scrollTop=previous.scroll;history.replaceState(null,'',previous.url);backDetail.hidden=!detailTrail.length;};
  function detailPage(title){
    const dialog=$('mainline-detail');
    if(dialog.open&&window.LumosRoleUI)detailTrail.push({title:$('detail-title').textContent,nodes:[...$('detail-content').childNodes],scroll:$('detail-content').scrollTop,url:location.href});
    $('detail-title').textContent=title;$('detail-content').replaceChildren();backDetail.hidden=!detailTrail.length;
    if(!dialog.open)dialog.showModal();$('detail-content').scrollTop=0;
    return $('detail-content');
  }
  function detailAction(label,parent,action){const button=el('button',label,'role-detail-button');button.onclick=action;parent.append(button);}
  function showHistory(items,title){window.LumosRoleUI.history(items,detailPage(title+' · 变更记录'),item=>window.LumosRoleUI.history([item],detailPage(title+' · 本次变化')));}
  function showSources(detail,title){
    const body=detailPage(title+' · 参考资料'),d=(detail.mainline||detail.task).data;
    const origin=d.last_source||d.source||{};
    body.append(el('p','这里保留原话和当时参考的资料；旧资料中的结论不代表当前进展。','muted'));
    if(origin.quote){body.append(el('h3','最近引用的原话'),el('blockquote',origin.quote));}
    if(origin.reason)body.append(el('p','采用依据：'+origin.reason));
    const sources=detail.sources||Object.entries(detail.documents||{}).map(([id,text])=>({title:(detail.document_info?.[id]?.relation==='direct'?'直接关联 · ':'项目背景 · ')+(detail.document_info?.[id]?.title||'工作资料'),text}));
    for(const source of sources){const row=window.LumosRoleUI.section(source.title||source.data?.title||'参考资料',body);window.LumosRoleUI.renderDocument(source.text||source.data?.text||'此处没有可读正文。',row);}
    for(const ref of detail.note_sources||[]){body.append(el('h3',(ref.note?.data?.title||'笔记原文')+' · 引用版本 '+ref.revision),el('p',ref.excerpt||ref.text||'该笔记未提供摘录。'));}
    for(const related of detail.related||[])if(related.kind!=='document')body.append(el('h3',related.data.title||'关联记录'),el('p',related.data.text||''));
    if(!sources.length&&!origin.quote&&!detail.note_sources?.length)body.append(el('p','此记录没有可展示的原文摘录。'));
  }
  function openReceipts(item){
    const body=detailPage(item.title+' · 答复与结果');
    for(const job of item.receipts){const d=job.data,row=window.LumosRoleUI.section(answerStatus(job),body);
      row.append(el('p',new Date(d.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · '+window.LumosModels.receipt(d),'muted'));
      row.append(el('h4','你提交的内容'),el('p',d.text));
      if(d.summary)row.append(el('h4','处理结果'),el('p',d.summary));
      if(d.error)row.append(el('p','未能完成：'+d.error));
      detailAction(d.status==='failed'?'查看并重试':'继续补充',row,()=>{const q=model.questions.find(q=>q.key===d.question_key)||{key:d.question_key,title:item.title,text:d.question_text||d.title,tasks:item.tasks,line:item.line};openFeedback(q);});
    }
    body.append(el('p','“已整理”表示答复已保存并接续工作记录，不代表业务任务已完成。','muted'));
  }
  async function openTask(task){
    const request=++detailRequest,body=detailPage(task.data.text);body.append(el('p','正在读取……'));
    try{
      const detail=await read('/api/task?id='+encodeURIComponent(task.id));if(request!==detailRequest||!$('mainline-detail').open)return;
      const d=detail.task.data;body.replaceChildren();
      body.append(el('p',(detail.task.short_id||task.short_id||'')+' · '+mainlineLabels[d.status]+' · '+(d.owner||'负责人待确定'),'muted'));
      for(const [title,text] of [['当前进展',d.progress],['下一步',d.next_step],['交付安排',d.planned_due||d.due||'未约定'],['完成日期',d.completed_on],['下次跟进',isOpenTask(detail.task)?d.follow_up||'尚未安排':''],['完成条件',d.condition]])if(text)body.append(el('h3',title),el('p',text==='long_term'?'长期':text));
      if(d.planning_reason)body.append(el('p','排期依据：'+d.planning_reason));
      detailAction('参考资料',body,()=>showSources(detail,d.text));
      detailAction('变更记录',body,()=>showHistory(detail.history,d.text));
      detailAction('向 Lumos 补充',body,()=>{openFeedback();if(![...$('feedback-target').options].some(o=>o.value===task.id))$('feedback-target').append(new Option(d.text,task.id));$('feedback-target').value=task.id;stashFeedback();});
    }catch(e){if(request===detailRequest)body.replaceChildren(el('p','读取失败：'+e.message));}
  }
  async function openLine(id) {
    const request=++detailRequest,dialog=$('mainline-detail'),body=$('detail-content');
    detailPage(model.entries.find(e=>e.line.id===id)?.line.data.title || '主线详情');
    body.replaceChildren(el('p','正在读取……'));
    if(!dialog.open)dialog.showModal();
    const url=new URL(window.location.href);url.searchParams.set('line',id);history.replaceState(null,'',url);
    try {
      const detail=await read('/api/mainline?id='+encodeURIComponent(id));if(request!==detailRequest || !dialog.open)return;
      const d=detail.mainline.data;body.replaceChildren();
      const scope=state.contexts.find(c=>c.id===d.context)?.data.workspace||(d.context==='lumos-maintenance'?'lumos':'lingguang');
      if(window.LumosRoleUI&&scope!==$('workspace').value){window.LumosRoleUI.scope(scope);render();}
      if(d.priority)body.append(el('p',`优先级 ${d.priority}${d.priority_basis==='agent'?' · Lumos安排':''}${d.priority_reason?'：'+d.priority_reason:''}`));
      body.append(el('h3','目标'),el('p',d.goal),el('h3','当前结论'),el('p',d.summary),el('p','摘要依据 '+(d.as_of||'日期未记录'),'muted'));
      if(!window.LumosRoleUI)body.append(reviewControl(detail.mainline));else if(d.review_on)body.append(el('p','下次复核：'+d.review_on,'muted'));
      const live=detail.tasks.filter(t=>!['archived','retained'].includes(t.context_status));
      body.append(el('h3','阶段交付'));dateGroups(milestoneTasks({line:detail.mainline,tasks:live}),body,'detail:'+id);
      body.append(el('h3','风险与下一步'),el('p',d.risk || '暂无已记录风险；不代表已经验证正常。'),el('p',d.next_step || '下一步待明确'));
      const related=el('div',undefined,'detail-links');for(const other of d.related_mainlines || []){const l=model.entries.find(e=>e.line.id===other)?.line;if(l)related.append(lineButton(l,l.data.title));}body.append(related);
      const tasks=fold('执行细项 · '+live.filter(isOpenTask).length,body,'detail:'+id+':tasks');
      for(const t of live.filter(isOpenTask).sort((a,b)=>Number(b.data.status==='blocked')-Number(a.data.status==='blocked') || deliverySort(a,b)))tasks.append(taskLink(t,true));
      const past=detail.tasks.filter(t=>!isOpenTask(t)||['archived','retained'].includes(t.context_status));
      if(past.length){const closed=fold('已结束 / 历史脉络任务 · '+past.length,body,'detail:'+id+':past');for(const t of past)closed.append(taskLink(t,true));}
      if(window.LumosRoleUI){
        detailAction('参考资料 · '+detail.sources.length,body,()=>showSources(detail,d.title));
        detailAction('变更记录 · '+detail.history.length,body,()=>showHistory(detail.history,d.title));
        return;
      }
      const sources=fold('依据与原文 · '+detail.sources.length,body,'detail:'+id+':sources');
      sources.append(el('p',d.source.ref,'source-text'));if(d.source.quote)sources.append(el('p',d.source.quote,'source-text'));if(d.source.reason)sources.append(el('p',d.source.reason,'source-text'));for(const source of detail.sources){const doc=fold(source.title,sources,'detail:'+id+':source:'+source.id);doc.append(el('p',source.text,'source-text'));}
      const versions=fold('主线历史 · '+detail.history.length,body,'detail:'+id+':history');
      for(const h of detail.history){const entry=fold(h.at.slice(0,10)+' · '+h.reason,versions,'detail:'+id+':history:'+h.at);entry.append(el('p',h.after?.data?.summary || ''));}
    }catch(e){if(request===detailRequest && dialog.open)body.replaceChildren(el('p','读取失败：'+e.message));}
  }
  function closed(){detailRequest++;detailTrail.length=0;backDetail.hidden=true;const url=new URL(window.location.href);url.searchParams.delete('line');history.replaceState(null,'',url);}
  $('close-detail').onclick=()=>$('mainline-detail').close();$('mainline-detail').addEventListener('close',closed);
  $('workspace').onchange=()=>{if($('answer-dialog').open)$('answer-dialog').close();activeQuestion=null;if($('mainline-detail').open)$('mainline-detail').close();const url=new URL(window.location.href);url.searchParams.delete('line');url.searchParams.set('workspace',$('workspace').value);history.replaceState(null,'',url);remember();if(state)render();receipts=[];receiptState='loading';renderQuestions();watchAnswers();};
  $('refresh').onclick=load;$('search').oninput=()=>{if(state)render();};$('clear-search').onclick=()=>{$('search').value='';render();$('search').focus();};
  $(deliveryView?'nav-delivery':'view-summary').setAttribute('aria-current','page');
  if(deliveryView){$('page-title').textContent='阶段交付';document.title='Lumos · 主线交付';$('page-description').textContent='跨主线按日期查看阶段成果；已过节点单独核对，原计划始终保留。';}
  load();
}
