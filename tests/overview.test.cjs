const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('all pages expose the same task entry in their global navigation',()=>{
  for(const file of ['overview','index','people','notes']){
    const html=fs.readFileSync('web/'+file+'.html','utf8');
    const nav=html.match(/<nav aria-label="工作视图"[\s\S]*?<\/nav>/)[0];
    assert.match(nav,/<a href="\/tasks"[^>]*>全部任务<\/a>/,file);
  }
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

test('due mainline review stays visible until its exact schedule is checked',()=>{
  const main=line('m',[]),s=state([],[main]);main.data.review_on=s.today;
  assert.equal(managementModel(s,'lingguang').issues.length,1);
  main.data.review_checked_on=s.today;
  assert.equal(managementModel(s,'lingguang').issues.length,0);
  main.data.review_revision=1;
  assert.equal(managementModel(s,'lingguang').issues.length,1);
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
  assert.deepEqual(view.issues[0].tasks.map(t=>t.id),['b']);
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
  assert.equal(targetDate(b),'2026-11-20');
  assert.equal(managementModel(state([a],[line('m',['a'])]),'lingguang').issues.length,0);
});
