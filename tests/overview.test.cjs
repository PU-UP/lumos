const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('all pages keep three everyday entries and retain contextual access to details',()=>{
  for(const file of ['overview','index','people','notes','knowledge','chat','agents']){
    const html=fs.readFileSync('web/'+file+'.html','utf8');
    const nav=html.match(/<nav aria-label="工作视图"[\s\S]*?<\/nav>/)[0];
    assert.deepEqual([...nav.matchAll(/<a [^>]*>(.*?)<\/a>/g)].map(m=>m[1]),['工作','对话','记录'],file);
    assert.match(html,/src="\/navigation.js"/,file);
  }
  const home=fs.readFileSync('web/overview.html','utf8');
  assert.match(home,/href="\/tasks"/);assert.match(home,/href="\/people"/);
  assert.match(fs.readFileSync('web/notes.html','utf8'),/href="\/knowledge"/);
});
const {managementModel,milestoneTasks,deliveryDate,targetDate,matchesTask,submission} = require('../web/overview.js');
test('uncertain submissions retry the original payload and suppress concurrent writes',async()=>{
  const calls=[];let finish;
  const sender=submission(async r=>{calls.push(r);if(calls.length===1)throw new Error('connection lost');return new Promise(resolve=>{finish=resolve;});});
  const original={request_id:'a',text:'original feedback'};
  await assert.rejects(sender.send(original));
  assert.equal(sender.pending,original);
  const retry=sender.send({request_id:'b',text:'new input'});
  assert.equal(await sender.send({request_id:'c'}),null);
  assert.equal(calls[1],original);finish({saved:true});await retry;assert.equal(sender.pending,null);
});
test('confirmed validation failure permits a corrected submission',async()=>{
  const sender=submission(async()=>{const error=new Error('stale');error.confirmed=true;throw error;});
  await assert.rejects(sender.send({request_id:'a'}));assert.equal(sender.pending,null);
});
const task=(id,changes={})=>({id,short_id:'T-'+id,data:{context:'work',text:id,status:'doing',...changes}});
const line=(id,tasks,milestones=tasks)=>({id,data:{context:'work',title:id,task_ids:tasks,milestone_ids:milestones}});
const state=(tasks,lines)=>({today:'2026-11-14',contexts:[{id:'work',data:{workspace:'lingguang'}},{id:'maintenance',data:{workspace:'lumos'}}],tasks,mainlines:lines});

test('Lumos owned work stays visible without asking the user for generic progress',()=>{
  const t=task('own',{owner:'Lumos',follow_up:'2026-11-14'}),s=state([t],[]);
  assert.equal(managementModel(s,'lingguang').questions.length,0);
  assert.equal(managementModel(s,'lingguang').independent.length,1);
  s.open_questions=[{workspace:'lingguang',intake_id:'ask',index:0,question:'需要确定备份落点',related_ids:['own']}];
  assert.equal(managementModel(s,'lingguang').questions.length,1);
});

test('mainlines sort by priority then existing order without changing input or task priority',()=>{
  const lines=['unset','P2','P1-later','P0','P1-first'].map(id=>line(id,['a']));
  for(const l of lines)if(l.id!=='unset')l.data.priority=l.id.slice(0,2);
  lines[2].data.order=2;
  const s=state([task('a',{priority:'low'})],lines),before=JSON.stringify(s);
  assert.deepEqual(managementModel(s,'lingguang').entries.map(e=>e.line.id),['P0','P1-first','P1-later','P2','unset']);
  assert.equal(JSON.stringify(s),before);
});

test('scheduled agent reviews alone do not become questions for Wang',()=>{
  const main=line('m',[]),s=state([],[main]);main.data.review_on=s.today;
  assert.equal(managementModel(s,'lingguang').questions.length,0);
  main.data.review_checked_on=s.today;
  assert.equal(managementModel(s,'lingguang').issues.length,0);
  main.data.review_revision=1;
  assert.equal(managementModel(s,'lingguang').questions.length,0);
  main.data.review_checked_revision=1;
  assert.equal(managementModel(s,'lingguang').issues.length,0);
  main.data.review_on='2026-11-15';
  assert.equal(managementModel(s,'lingguang').issues.length,0);
});

test('overview includes blocked and independent tasks while respecting workspace',()=>{
  const s=state([task('a',{status:'blocked'}),task('b',{status:'blocked'}),task('c',{context:'maintenance',status:'blocked'})],[line('main',['a'])]);
  const view=managementModel(s,'lingguang');
  assert.deepEqual(view.tasks.map(t=>t.id),['a','b']);
  assert.deepEqual(view.independent.map(t=>t.id),['b']);
  assert.equal(view.issues.length,2);
});
test('closed tasks never create alerts; missing dates are not management risk',()=>{
  const s=state([task('a',{status:'done',due:'2026-01-01'}),task('b',{status:'cancelled',due:'2026-01-01'}),task('c')],[line('main',['a','b','c'])]);
  const view=managementModel(s,'lingguang');
  assert.equal(view.issues.length,0);
  assert.deepEqual(milestoneTasks(view.entries[0]).map(t=>t.id),['c']);
});
test('delivery uses original due, separates long term and undated, and preserves overdue milestones',()=>{
  const s=state([task('a',{due:'2026-11-18',follow_up:'2026-11-01'}),task('b',{due:'2026-11-13',follow_up:'2026-12-01'}),task('c',{due:'long_term'}),task('d'),task('e',{due:'2026-11-15'})],[line('main',['a','b','c','d','e'],['a','b','c','d'])]);
  const view=managementModel(s,'lingguang'),entry=view.entries[0];
  assert.deepEqual(milestoneTasks(entry).map(t=>t.id),['b','a','c','d']);
  assert.ok(!milestoneTasks(entry).some(t=>t.id==='e'));
  assert.equal(deliveryDate(entry.tasks[2]),'');
  assert.deepEqual(view.issues[0].tasks.map(t=>t.id),['a']);
});
test('shared task is referenced once per line without copying or changing it',()=>{
  const s=state([task('a',{due:'2026-11-13',status:'blocked'})],[line('main',['a']),line('other',['a'])]);
  const before=JSON.stringify(s),view=managementModel(s,'lingguang');
  assert.equal(view.entries[0].tasks[0],view.entries[1].tasks[0]);
  assert.equal(view.issues[0].tasks.length,1);
  assert.equal(view.independent.length,0);
  assert.equal(JSON.stringify(s),before);
});
test('search finds short id, progress and owner regardless of collapse and status',()=>{
  const t=task('041',{status:'done',progress:'相机盲区结果',owner:'测试人员'});
  assert.ok(matchesTask(t,'t-041'));assert.ok(matchesTask(t,'盲区'));assert.ok(matchesTask(t,'测试人员'));
  assert.equal(matchesTask(t,'not found'),false);
});

test('Agent targets appear on the timeline without replacing promises or becoming overdue commitments',()=>{
  const a=task('a',{planned_due:'2026-11-13'}),b=task('b',{due:'2026-11-20',planned_due:'2026-11-18'});
  assert.equal(targetDate(a),'2026-11-13');assert.equal(deliveryDate(a),'');
  assert.equal(targetDate(b),'2026-11-18');
  assert.equal(deliveryDate(b),'2026-11-20');
  const view=managementModel(state([a],[line('m',['a'])]),'lingguang');
  assert.equal(view.issues.length,1);assert.doesNotMatch(view.issues[0].reason,/交付已过/);
});

const vm=require('node:vm');
class Control {
  constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.open=false;this.textContent='';this.parentElement={};this.events={};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  setAttribute(){}
  addEventListener(name,fn){this.events[name]=fn;}
  showModal(){this.open=true;}
  close(){this.open=false;this.events.close?.();}
  focus(){}
  get options(){return this.children;}
  requestSubmit(){this.saving=this.onsubmit({preventDefault(){}});}
}
function reviewPage(post,navigation={}){
  const ids=new Map(),get=id=>{if(!ids.has(id))ids.set(id,new Control());return ids.get(id);};
  get('workspace').value='lingguang';
  const snapshot=state([],[line('m',[])]);snapshot.seq=1;snapshot.writable=true;
  const drafts=navigation.storage||new Map([['lumos.management.v1',JSON.stringify({workspace:navigation.workspace})]]);let onUpdate;
  const events={};
  const location=new URL('http://localhost/'+(navigation.search||''));
  const world={document:{getElementById:get,createElement:t=>new Control(t),querySelector:()=>new Control()},
    window:{location,addEventListener:(name,fn)=>events[name]=fn,LumosIntake:{watch:(host,workspace,note,finished,update)=>{onUpdate=update;}}},URL,URLSearchParams,history:{replaceState:(_state,_title,url)=>{location.href=url.href;}},localStorage:{getItem:k=>drafts.get(k)||null,setItem:(k,v)=>drafts.set(k,v)},
    Option:function(text,value){this.textContent=text;this.value=value;},crypto:{randomUUID:()=> 'a'.repeat(32)},
    fetch:async(url,options)=>{if(options)return post(JSON.parse(options.body),snapshot);return {ok:true,json:async()=>snapshot};}};
  world.Event = Event;
  if(navigation.model)world.window.LumosModels={get:()=>navigation.model,receipt:()=>navigation.model};
  vm.createContext(world);vm.runInContext(fs.readFileSync('web/disclosure.js','utf8'),world);vm.runInContext(fs.readFileSync('web/dialog.js','utf8'),world);vm.runInContext(fs.readFileSync('web/work-model.js','utf8'),world);vm.runInContext(fs.readFileSync('web/overview.js','utf8'),world);
  const controls=()=>{const walk=n=>[n,...n.children.flatMap(walk)];const form=walk(get('mainlines')).find(n=>n.tag==='form');return {form,date:form.children[0].children[0],save:form.children[1],message:form.children[2]};};
  return {get,controls,snapshot,location,events,receipts:data=>onUpdate(data)};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('overview replies use the Lumos conversation model and freeze it for an uncertain retry',async()=>{
  const sent=[],navigation={model:'gpt-6.2-astra'};
  const p=reviewPage(async request=>{sent.push(request);if(sent.length===1)throw Error('connection lost');return {ok:true,json:async()=>({intake:{id:'x',data:{...request,status:'pending'}}})};},navigation);
  await settle();p.get('open-feedback').onclick({});p.get('feedback-text').value='新的进展';await p.get('feedback-form').onsubmit({preventDefault(){}});
  navigation.model='gpt-6.2-sol';await p.get('feedback-form').onsubmit({preventDefault(){}});
  assert.equal(sent[0].model,'gpt-6.2-astra');assert.deepEqual(sent[1],sent[0]);
});

test('reopening overview restores disclosure choices including closed defaults and workspace isolation',async()=>{
  const storage=new Map();
  const first=reviewPage(undefined,{storage});await settle();
  first.get('attention').open=false;first.get('intake-panel').open=true;first.events.pagehide();
  const reopened=reviewPage(undefined,{storage});await settle();
  assert.equal(reopened.get('attention').open,false);assert.equal(reopened.get('intake-panel').open,true);
  reopened.get('workspace').value='lumos';reopened.get('workspace').onchange();
  assert.equal(reopened.get('intake-panel').open,false);
  reopened.get('workspace').value='lingguang';reopened.get('workspace').onchange();
  assert.equal(reopened.get('attention').open,false);assert.equal(reopened.get('intake-panel').open,true);
});

test('review links open the requested workspace and subsequent switches keep the URL consistent',async()=>{
  const p=reviewPage(undefined,{workspace:'lingguang',search:'?workspace=lumos'});await settle();
  assert.equal(p.get('workspace').value,'lumos');
  assert.equal(p.get('mainlines').children[0].textContent,'此空间尚未建立主线，独立事项仍可在下方查看。');
  p.get('workspace').value='lingguang';p.get('workspace').onchange();
  assert.equal(p.location.search,'?workspace=lingguang');
  const invalid=reviewPage(undefined,{workspace:'lumos',search:'?workspace=unknown'});await settle();
  assert.equal(invalid.get('workspace').value,'lumos');
});

test('question and receipt disclosures keep live state through polling, count changes and refreshes',async()=>{
  const p=reviewPage();await settle();
  p.snapshot.mainlines[0].data.review_on=p.snapshot.today;
  p.snapshot.mainlines.push(...Array.from({length:3},(_,i)=>line('extra'+i,[])));
  p.snapshot.mainlines.forEach(l=>l.data.review_on=p.snapshot.today);
  p.snapshot.open_questions=Array.from({length:5},(_,index)=>({intake_id:'old',index,workspace:'lingguang',question:'阶段结果 '+index,related_ids:[p.snapshot.mainlines[index%4].id]}));
  p.get('search').oninput();
  const find=(id,title)=>p.get(id).children.find(n=>n.tag==='details' && n.children[0].textContent.startsWith(title));
  find('attention-items','其他当前问题').open=true;
  const reply={id:'reply',data:{workspace:'lingguang',question_key:'question:old:0',status:'running',title:'结果',text:'已答复'}};
  p.receipts({intakes:[reply]});
  assert.equal(find('attention-items','其他当前问题').open,true);
  assert.equal(find('answer-progress','答复处理进度').open,true);
  find('answer-progress','答复处理进度').open=false;
  p.receipts({intakes:[reply]});
  assert.equal(find('answer-progress','答复处理进度').open,false);
  find('answer-progress','答复处理进度').open=true;
  reply.data.status='done';p.receipts({intakes:[reply]});
  assert.equal(find('answer-progress','答复处理进度').open,true);
  p.snapshot.mainlines[0].data.review_on='2026-12-01';p.get('search').oninput();
  find('attention-items','后续再跟进').open=true;
  p.receipts(null);p.receipts({intakes:[reply]});await p.get('refresh').onclick();
  assert.equal(find('attention-items','后续再跟进').open,true);
  p.snapshot.mainlines[0].data.review_on=p.snapshot.today;p.get('search').oninput();
  assert.equal(find('attention-items','其他当前问题').open,true);
  p.get('workspace').value='lumos';p.snapshot.mainlines.forEach(l=>l.data.context='maintenance');
  p.snapshot.open_questions.forEach(q=>q.workspace='lumos');p.get('search').oninput();
  assert.equal(find('attention-items','其他当前问题').open,false);
});

test('mainline disclosures survive full rerenders without sharing state between lines',async()=>{
  const p=reviewPage();await settle();
  p.snapshot.mainlines.push(line('other',[]));p.get('search').oninput();
  const schedules=()=>p.get('mainlines').children.map(row=>row.children.find(n=>n.tag==='details'));
  schedules()[0].open=true;
  await p.get('refresh').onclick();
  assert.deepEqual(schedules().map(n=>n.open),[true,false]);
  schedules()[0].open=false;p.get('search').oninput();
  assert.equal(schedules()[0].open,false);
});
test('date change saves automatically and survives a reload including explicit clearing',async()=>{
  const posts=[];const p=reviewPage(async(request,s)=>{posts.push(request);s.mainlines[0].data.review_on=request.review_on;return {ok:true,json:async()=>({seq:++s.seq})};});
  await settle();let c=p.controls();c.date.value='2026-11-20';c.date.onchange();await c.form.saving;
  c=p.controls();assert.equal(c.date.value,'2026-11-20');assert.match(c.message.textContent,/已保存/);
  c.date.value='';c.date.onchange();await c.form.saving;
  assert.equal(posts.length,2);assert.equal(posts[1].review_on,'');assert.equal(p.controls().date.value,'');
});
test('failed date saves retain input across rerenders and retry the same request',async()=>{
  const posts=[];const p=reviewPage(async(request,s)=>{posts.push(request);if(posts.length===1)throw new Error('lost response');s.mainlines[0].data.review_on=request.review_on;return {ok:true,json:async()=>({})};});
  await settle();let c=p.controls();c.date.value='2026-11-20';c.date.onchange();await c.form.saving;
  assert.match(c.message.textContent,/输入已保留/);
  p.get('search').oninput();c=p.controls();assert.equal(c.date.value,'2026-11-20');assert.equal(c.save.hidden,false);
  c.form.requestSubmit();await c.form.saving;assert.deepEqual(posts[0],posts[1]);assert.equal(p.controls().date.value,'2026-11-20');
});

test('review status follows current records and never calls an edited draft saved',async()=>{
  const p=reviewPage(async(request,s)=>{s.mainlines[0].data.review_on=request.review_on;return {ok:true,json:async()=>({})};});
  await settle();let c=p.controls();c.date.value='2026-11-20';c.date.onchange();await c.form.saving;
  c=p.controls();c.date.value='2026-11-21';c.date.oninput();p.get('search').oninput();
  c=p.controls();assert.equal(c.date.value,'2026-11-21');assert.equal(c.message.textContent,'尚未保存');
  c.form.requestSubmit();await c.form.saving;
  p.snapshot.mainlines[0].data.review_checked_on='2026-11-21';await p.get('refresh').onclick();
  assert.equal(p.controls().message.textContent,'本次已复核');
});

test('reverting an edit discards its draft so later refreshes show the latest saved date',async()=>{
  const p=reviewPage();await settle();let c=p.controls();
  c.date.value='2026-11-20';c.date.oninput();c.date.value='';c.date.oninput();
  assert.equal(c.message.textContent,'未安排复核');
  p.snapshot.mainlines[0].data.review_on='2026-11-22';await p.get('refresh').onclick();
  assert.equal(p.controls().date.value,'2026-11-22');assert.equal(p.controls().message.textContent,'已保存：2026-11-22');
});

test('due follow-ups become questions and future milestones stay separate from overdue delivery',()=>{
  const s=state([task('a',{follow_up:'2026-11-14',due:'2026-11-20'}),task('b',{due:'2026-11-01'}),task('c',{planned_due:'2026-11-28'}),task('d',{due:'2026-11-29'})],[line('main',['a','b','c','d'])]);
  const before=JSON.stringify(s),view=managementModel(s,'lingguang');
  assert.match(view.questions[0].text,/2026-11-14/);
  assert.deepEqual(view.upcoming.map(t=>t.id),['a','c']);
  assert.equal(JSON.stringify(s),before);
});

test('saved questions use exact task numbers and never guess a line from batch destinations',()=>{
  const s=state([task('001',{follow_up:'2026-11-14'})],[line('main',['001']),line('other',[])]);
  s.open_questions=[{workspace:'lingguang',question:'T-001的结果？',destinations:['main','other']},{workspace:'lumos',question:'other workspace'}];
  const view=managementModel(s,'lingguang');assert.equal(view.questions.length,1);assert.equal(view.questions[0].line.id,'main');
  s.open_questions[0].question='项目总体方向？';
  assert.equal(managementModel(s,'lingguang').questions[0].line,undefined);
});

test('answer dialog keeps separate drafts and restores them after closing',async()=>{
  const p=reviewPage();await settle();
  p.snapshot.mainlines[0].data.review_on=p.snapshot.today;
  p.snapshot.open_questions=[{intake_id:'old',index:0,workspace:'lingguang',question:'阶段结果是什么？',related_ids:['m']}];
  p.get('feedback-text').value='原来的综合草稿';p.get('feedback-text').oninput();p.get('search').oninput();
  const row=p.get('attention-items').children[0],answer=row.children.find(n=>n.tag==='button');
  answer.onclick();assert.equal(p.get('answer-dialog').open,true);assert.equal(p.get('feedback-text').value,'');
  p.get('feedback-text').value='这件事的答复';p.get('feedback-text').oninput();p.get('answer-dialog').close();answer.onclick();
  assert.equal(p.get('feedback-text').value,'这件事的答复');
  assert.equal(p.get('feedback-target').value,'m');
  p.get('answer-dialog').close();p.get('open-feedback').onclick({});assert.equal(p.get('feedback-text').value,'原来的综合草稿');
});

test('submitted replies leave the waiting list and show real processing states',async()=>{
  let posted;
  const p=reviewPage(async request=>{posted=request;return {ok:true,json:async()=>({intake:{id:'reply',data:{...request,status:'pending',created_at:'2026-11-17'}}})};});await settle();
  p.snapshot.mainlines[0].data.review_on=p.snapshot.today;
  p.snapshot.open_questions=[{intake_id:'old',index:0,workspace:'lingguang',question:'阶段结果？',related_ids:['m']}];p.get('search').oninput();
  p.get('attention-items').children[0].children.find(n=>n.tag==='button').onclick();
  p.get('feedback-text').value='已完成阶段测试';await p.get('feedback-form').onsubmit({preventDefault(){}});
  assert.equal(posted.question_key,'question:old:0');assert.match(posted.text,/阶段结果？\n\n王牧楠答复：\n已完成阶段测试/);
  assert.equal(p.get('attention-items').children.some(n=>n.tag==='article'),false);
  assert.equal(p.get('answer-dialog').open,false);assert.equal(p.get('feedback-text').value,'');assert.match(p.get('answer-notice').textContent,/答复已保存/);
  p.get('answer-progress').children[0].children[1].children.find(n=>n.tag==='button').onclick();
  assert.equal(p.get('feedback-submit').disabled,true);assert.match(p.get('answer-receipt').children[0].textContent,/等待整理/);
  p.receipts({executor:'available',intakes:[{id:'reply',data:{...posted,status:'running'}}]});assert.match(p.get('answer-receipt').children[0].textContent,/正在整理/);
  p.receipts({executor:'available',intakes:[{id:'reply',data:{...posted,status:'done',summary:'任务已接续'}}]});assert.equal(p.get('answer-receipt').children[0].textContent,'已整理 · 结果已保存');assert.equal(p.get('feedback-submit').disabled,false);
  assert.ok(p.get('answer-receipt').children.some(n=>n.textContent.includes('不要求立即补答')));
  p.snapshot.open_questions=[];p.get('search').oninput();
  p.receipts({executor:'available',intakes:[{id:'reply',data:{...posted,status:'done',summary:'任务已接续'}}]});assert.equal(p.get('answer-receipt').children[0].textContent,'已整理 · 结果已保存');
  p.receipts(null);assert.match(p.get('feedback-status').textContent,/无法读取/);
});

test('uncertain answer submissions preserve text and retry exactly the same request',async()=>{
  const posts=[];const p=reviewPage(async request=>{posts.push(request);throw new Error('lost response');});await settle();
  p.get('open-feedback').onclick({});p.get('feedback-text').value='不能丢失';
  await p.get('feedback-form').onsubmit({preventDefault(){}});p.get('answer-dialog').close();p.get('open-feedback').onclick({});
  assert.equal(p.get('feedback-text').value,'不能丢失');assert.equal(p.get('feedback-text').readOnly,true);
  await p.get('feedback-form').onsubmit({preventDefault(){}});assert.deepEqual(posts[0],posts[1]);assert.match(p.get('feedback-status').textContent,/未能确认/);
});

test('an unconfirmed submission can be reconciled even when its receipt is already pending',async()=>{
  let posted;
  const p=reviewPage(async request=>{posted=request;throw new Error('lost response');});await settle();
  p.snapshot.mainlines[0].data.review_on=p.snapshot.today;
  p.snapshot.open_questions=[{intake_id:'old',index:0,workspace:'lingguang',question:'结果？',related_ids:['m']}];p.get('search').oninput();
  p.get('attention-items').children[0].children.find(n=>n.tag==='button').onclick();p.get('feedback-text').value='阶段结果';
  await p.get('feedback-form').onsubmit({preventDefault(){}});
  p.receipts({executor:'available',intakes:[{id:'reply',data:{...posted,status:'pending'}}]});
  assert.equal(p.get('feedback-submit').disabled,false);assert.equal(p.get('feedback-submit').textContent,'重试提交');
});

test('question inbox prioritizes different mainlines and matches latest receipts only within workspace',()=>{
  const {questionInbox}=require('../web/overview.js');
  const questions=[{key:'a',title:'A'},{key:'b',title:'A'},{key:'c',title:'C'},{key:'d',title:'D'}];
  assert.deepEqual(questionInbox(questions,[],'lingguang').primary.map(q=>q.key),['a','c','d']);
  const jobs=[{id:'old',data:{workspace:'lingguang',question_key:'a',created_at:'2026-11-16',status:'failed'}},{id:'new',data:{workspace:'lingguang',question_key:'a',created_at:'2026-11-17',status:'pending'}},{id:'foreign',data:{workspace:'lumos',question_key:'c',created_at:'2026-11-18'}}];
  const inbox=questionInbox(questions,jobs,'lingguang');assert.equal(inbox.latest.get('a').id,'new');assert.deepEqual(inbox.primary.map(q=>q.key),['b','c','d']);
});

test('future followups stay out of current questions even when delivery is overdue or task blocked',()=>{
  const {questionInbox,taskQuestionTiming}=require('../web/overview.js');
  const s=state([task('001',{due:'2026-11-01',follow_up:'2026-12-01',status:'blocked'}),task('002',{follow_up:'2026-11-14'}),task('003',{due:'2026-11-14',follow_up:'2026-11-20'}),task('004',{status:'done',follow_up:'2026-11-01'}),task('005')],[]);
  s.open_questions=s.tasks.map((t,index)=>({workspace:'lingguang',intake_id:'old',index,question:t.short_id+'的结果？'}));
  const original=JSON.stringify(s),view=managementModel(s,'lingguang'),inbox=questionInbox(view.questions,[],'lingguang');
  assert.deepEqual(inbox.primary.map(q=>q.index),[1,2]);
  assert.deepEqual(inbox.rest.map(q=>q.index),[]);
  assert.deepEqual(inbox.later.map(q=>q.index).sort(),[0,3,4]);
  assert.match(inbox.later.find(q=>q.index===0).timingReason,/2026-12-01/);
  assert.equal(JSON.stringify(s),original);
  assert.equal(taskQuestionTiming(s.tasks[0],'2026-12-01').needed,true);
  assert.ok(!view.issues.some(i=>i.tasks.some(t=>t.id==='001')));
});

test('failed submissions keep the answer dialog open with its draft',async()=>{
  const p=reviewPage(async()=>{throw new Error('offline');});await settle();
  p.get('open-feedback').onclick({});p.get('feedback-text').value='保留的答复';
  await p.get('feedback-form').onsubmit({preventDefault(){}});
  assert.equal(p.get('answer-dialog').open,true);assert.equal(p.get('feedback-text').value,'保留的答复');
});

test('review question maps to its exact mainline and needs an answer even with future followup',()=>{
 const a=task('a',{due:'2026-11-01',planned_due:'2026-11-25',follow_up:'2026-11-20'});
 a.management_question={intake_id:'review',index:0};
 const s=state([a],[line('m',['a'])]);
 s.open_questions=[{workspace:'lingguang',intake_id:'review',index:0,question:'验证是否通过？',related_ids:[]}];
 const view=managementModel(s,'lingguang');
 assert.equal(view.questions[0].line.id,'m');assert.equal(view.questions[0].needsAnswer,true);
 assert.equal(view.issues.length,0);assert.equal(view.upcoming[0].id,'a');
});

test('shared tasks do not obscure the single mainline covering the question',()=>{
 const s=state([task('015'),task('041'),task('052')],[line('camera',['015','041','052']),line('lidar',['015'])]);
 s.open_questions=[{workspace:'lingguang',intake_id:'q',index:0,question:'T-015/T-041/T-052 样品到了吗？'}];
 let q=managementModel(s,'lingguang').questions[0];assert.equal(q.title,'camera');assert.equal(q.line.id,'camera');
 s.open_questions[0].question='T-015 安装角度是否确定？';q=managementModel(s,'lingguang').questions[0];
 assert.equal(q.line,undefined);assert.equal(q.title,'camera / lidar');
});

test('closed tasks keep review history without requesting another answer',()=>{
 for(const status of ['done','cancelled']){
  const a=task('a',{status,follow_up:'2026-11-01'});
  a.management_question={intake_id:'review',index:0};
  const s=state([a],[line('m',['a'])]);
  s.open_questions=[{workspace:'lingguang',intake_id:'review',index:0,question:'历史验证结果？'}];
  const q=managementModel(s,'lingguang').questions[0];
  assert.equal(q.needsAnswer,false);assert.equal(q.line.id,'m');
 }
});

test('partial answers and due event waits stay actionable without duplicating submitted answers',()=>{
 const {questionInbox}=require('../web/overview.js');
 const a=task('a',{status:'blocked',due:'2026-11-01',follow_up:'2026-11-01'});
 a.management_question={intake_id:'old',index:0};
 const s=state([a],[line('m',['a'])]);
 s.open_questions=[{workspace:'lingguang',intake_id:'old',index:0,question:'谁确认发布？',answer_state:'waiting',waiting_for:'联调后确认',review_on:''}];
 const receipt={id:'reply',data:{workspace:'lingguang',question_key:'question:old:0',status:'done'}};
 let q=managementModel(s,'lingguang').questions;let box=questionInbox(q,[receipt],'lingguang');
 assert.equal(box.primary.length,1);assert.equal(box.later.length,0);assert.match(box.primary[0].timingReason,/联调后确认/);
 s.open_questions[0].review_on=s.today;
 q=managementModel(s,'lingguang').questions;assert.equal(questionInbox(q,[receipt],'lingguang').primary.length,1);
 s.open_questions[0].answer_state='pending';
 q=managementModel(s,'lingguang').questions;box=questionInbox(q,[receipt],'lingguang');
 assert.equal(box.primary[0].text,'谁确认发布？');
 assert.equal(questionInbox(q,[{...receipt,data:{...receipt.data,status:'running'}}],'lingguang').primary.length,0);
});

test('waiting questions do not swallow other due tasks and one mainline needs only one reply',()=>{
 const {questionInbox}=require('../web/overview.js');
 const s=state([task('001',{follow_up:'2026-11-14'}),task('002',{follow_up:'2026-11-14'}),task('003',{follow_up:'2026-11-14'})],[line('m',['001','002','003'])]);
 s.open_questions=[{workspace:'lingguang',intake_id:'old',index:0,question:'T-001 实测结果？',task_ids:['001'],answer_state:'waiting',follow_up_on:'2026-11-20'}];
 let view=managementModel(s,'lingguang'),box=questionInbox(view.questions,[],'lingguang');
 assert.equal(box.primary.length,1);assert.deepEqual(box.primary[0].tasks.map(t=>t.id),['002','003']);assert.equal(box.later.length,1);
 s.open_questions[0].follow_up_on=s.today;
 view=managementModel(s,'lingguang');box=questionInbox(view.questions,[],'lingguang');
 assert.equal(box.primary.length,1);assert.equal(box.rest.length,0);assert.equal(box.primary[0].question_keys.length,2);
 assert.deepEqual(new Set(box.primary[0].tasks.map(t=>t.id)),new Set(['001','002','003']));
 const receipt={id:'reply',data:{workspace:'lingguang',question_key:box.primary[0].key,question_keys:box.primary[0].question_keys,status:'running'}};
 assert.equal(questionInbox(view.questions,[receipt],'lingguang').primary.length,0);
});
