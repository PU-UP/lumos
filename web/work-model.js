'use strict';
(function(){
const mainlineLabels = {todo:'待处理', doing:'进行中', blocked:'受阻', done:'已完成', cancelled:'已取消'};
const isOpenTask = t => !['done', 'cancelled'].includes(t.data.status);
const deliveryDate = t => /^\d{4}-\d{2}-\d{2}$/.test(t.data.due || '') ? t.data.due : '';
const targetDate = t => deliveryDate(t) || t.data.planned_due || '';
const deliverySort = (a, b) => (targetDate(a) || '9999').localeCompare(targetDate(b) || '9999') || a.id.localeCompare(b.id);
const mainlineSort = (a, b) => (a.data.priority || 'P4').localeCompare(b.data.priority || 'P4') || (a.data.order || 0)-(b.data.order || 0) || a.id.localeCompare(b.id);
function taskQuestionTiming(task,today){
  const d=task.data;if(!isOpenTask(task))return {needed:false,reason:'相关任务已结束，历史问题待复核'};
  if(deliveryDate(task)===today)return {needed:true,reason:'交付节点 '+today};
  if(d.follow_up)return {needed:d.follow_up<=today,reason:(d.follow_up<=today?'已到跟进日 ':'下次跟进 ')+d.follow_up};
  const due=targetDate(task);
  if(due && due<=today)return {needed:true,reason:'阶段节点 '+due+'，结果待核对'};
  if(d.status==='blocked')return {needed:true,reason:'事项受阻，尚未安排跟进'};
  return {needed:false,reason:due?'阶段节点 '+due:'尚未安排提问时间，由Lumos接续'};
}
function managementModel(state, workspace) {
  const spaceOf = context => state.contexts.find(c => c.id === context)?.data.workspace || (context === 'lumos-maintenance' ? 'lumos' : 'lingguang');
  const tasks = state.tasks.filter(t => spaceOf(t.data.context) === workspace);
  const lines = (state.mainlines || []).filter(l => spaceOf(l.data.context) === workspace && l.data.status !== 'archived');
  const assigned = new Set(lines.flatMap(l => l.data.task_ids || []));
  const entries = lines.sort(mainlineSort).map(line => ({line, tasks: tasks.filter(t => (line.data.task_ids || []).includes(t.id))}));
  const independent = tasks.filter(t => !assigned.has(t.id));
  const issues = [];
  for (const entry of entries) {
    const current = entry.tasks.filter(t=>taskQuestionTiming(t,state.today).needed);
    const blocked = current.filter(t => t.data.status === 'blocked');
    const followups = current.filter(t => t.data.follow_up && t.data.follow_up <= state.today);
    const overdue = current.filter(t => targetDate(t) && targetDate(t) <= state.today);
    const affected = [...new Map([...blocked, ...overdue, ...followups].map(t => [t.id,t])).values()];
    const d=entry.line.data;
    if (affected.length) issues.push({title:d.title, line:entry.line, tasks:affected,
      severity:blocked.length ? 0 : 1, reason:blocked.length ? '有受阻事项，需核对影响与协作' : overdue.length ? '已到阶段核对节点，需补充结果' : '已到跟进节点，需要补充结果',
      date:affected.map(deliveryDate).filter(Boolean).sort()[0] || d.review_on || '9999'});
  }
  for (const task of independent.filter(t => taskQuestionTiming(t,state.today).needed)) {
    issues.push({title:task.data.text, tasks:[task], severity:task.data.status === 'blocked' ? 0 : 1,
      reason:task.data.status === 'blocked' ? '独立事项受阻' : '独立事项需核对', date:deliveryDate(task) || '9999'});
  }
  issues.sort((a,b) => a.severity-b.severity || a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const questions=(state.open_questions || []).filter(q=>q.workspace===workspace).map(q=>{
    const mentioned=tasks.filter(t=>t.short_id && (q.question.match(/T-\d+/g)||[]).includes(t.short_id));
    const refs=mentioned.length?mentioned.map(t=>t.id):(q.related_ids||[]);
    const matches=entries.filter(e=>refs.includes(e.line.id) || e.tasks.some(t=>refs.includes(t.id)));
    const entry=matches.length===1?matches[0]:null;
    return {...q, key:`question:${q.intake_id}:${q.index}`, title:entry?.line.data.title || '跨事项待确认', line:entry?.line, tasks:tasks.filter(t=>refs.includes(t.id)), text:q.question};
  });
  questions.sort((a,b)=>Number(b.tasks.some(t=>t.data.follow_up && t.data.follow_up<=state.today))-Number(a.tasks.some(t=>t.data.follow_up && t.data.follow_up<=state.today)));
  for(const issue of issues) {
    if(questions.some(q=>(q.line && q.line.id===issue.line?.id) || q.tasks.some(t=>issue.tasks.some(other=>other.id===t.id))))continue;
    const names=issue.line ? issue.line.data.title : issue.tasks.map(t=>t.data.text).join('、');
    const revision=[issue.line?.data.review_on,...issue.tasks.map(t=>t.data.follow_up)].filter(Boolean).sort().at(-1)||'';
    questions.push({...issue,key:`followup:${issue.line?.id||issue.tasks[0].id}:${revision}`,text:names ? `截至 ${state.today}，${names}有什么结果或阻塞？尚未完成的部分下一步怎样推进？` : `截至 ${state.today}，${issue.title}是否有影响方向或阶段节点的新情况？`});
  }
  for(const q of questions){
    const timing=q.tasks.map(t=>taskQuestionTiming(t,state.today));
    if(!timing.length && q.line?.data.review_on)timing.push({needed:q.line.data.review_on<=state.today,reason:'主线复核 '+q.line.data.review_on});
    q.needsAnswer=timing.some(t=>t.needed);
    q.timingReason=[...new Set(timing.filter(t=>t.needed===q.needsAnswer).map(t=>t.reason))].join('；')||'尚未安排提问时间，由Lumos接续';
  }
  const milestones=[...new Map(entries.flatMap(e=>milestoneTasks(e)).map(t=>[t.id,t])).values()].sort(deliverySort);
  const horizon=new Date(state.today+'T00:00:00Z');horizon.setUTCDate(horizon.getUTCDate()+14);
  const upcoming=milestones.filter(t=>targetDate(t)>=state.today && targetDate(t)<=horizon.toISOString().slice(0,10));
  return {entries, independent, issues, tasks, questions, milestones, upcoming};
}
function milestoneTasks(entry) {
  return entry.tasks.filter(t => isOpenTask(t) && (entry.line.data.milestone_ids || []).includes(t.id)).sort(deliverySort);
}
function matchesTask(task, query) {
  return [task.short_id, task.data.text, task.data.progress, task.data.next_step, task.data.owner].join(' ').toLowerCase().includes(query.toLowerCase());
}
function questionInbox(questions, receipts, workspace) {
  const latest=new Map();
  for(const job of [...receipts].sort((a,b)=>(b.data.created_at||'').localeCompare(a.data.created_at||''))) {
    if(job.data.workspace===workspace && job.data.question_key && !latest.has(job.data.question_key))latest.set(job.data.question_key,job);
  }
  const unanswered=questions.filter(q=>!latest.has(q.key)),waiting=unanswered.filter(q=>q.needsAnswer!==false),later=unanswered.filter(q=>q.needsAnswer===false),primary=[], rest=[], seen=new Set();
  for(const q of waiting){const group=q.line?.id||q.title;if(primary.length<3 && !seen.has(group)){primary.push(q);seen.add(group);}else rest.push(q);}
  return {primary,rest,later,latest};
}
const model={mainlineLabels,isOpenTask,deliveryDate,targetDate,deliverySort,mainlineSort,taskQuestionTiming,managementModel,milestoneTasks,matchesTask,questionInbox};
if(typeof module!=='undefined')module.exports=model;
else window.LumosWorkModel=model;
})();
