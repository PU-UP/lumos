const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.textContent='';}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
}
function page(fetch){
  const timers=new Map();let timer=0;
  const world={window:{},document:{createElement:tag=>new Element(tag)},fetch,crypto:{randomUUID:()=> '1'.repeat(32)},
    setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)};
  vm.createContext(world);vm.runInContext(fs.readFileSync('web/intake.js','utf8'),world);
  return {api:world.window.LumosIntake,host:new Element(),timers};
}
const response=data=>({ok:true,json:async()=>data});
const data=jobs=>({enabled:true,executor:'available',token:'test',intakes:jobs});
const job=(status='failed')=>({id:'intake-test',data:{title:'<script>text only</script>',status,revision:2,questions:[]}});
const flatten=n=>[n,...n.children.flatMap(flatten)];

test('receipt and source disclosures retain open and closed choices across polls and watcher restarts',async()=>{
  const item=job('running');item.data.note={id:'note'};let fail=false;
  const p=page(async()=>{if(fail)throw new Error('offline');return response(data([item]));});
  const folds=()=>flatten(p.host).filter(n=>n.tag==='details');
  await p.api.watch(p.host,'lingguang');
  assert.equal(folds()[0].open,false);
  folds().forEach(n=>n.open=true);
  await [...p.timers.values()].at(-1)();
  assert.deepEqual(folds().map(n=>n.open),[true,true]);
  fail=true;await [...p.timers.values()].at(-1)();fail=false;
  item.data.status='needs_review';await [...p.timers.values()].at(-1)();
  assert.deepEqual(folds().map(n=>n.open),[true,true]);
  folds().forEach(n=>n.open=false);await p.api.watch(p.host,'lingguang');
  assert.deepEqual(folds().map(n=>n.open),[false,false]);
  await p.api.watch(p.host,'lingguang','note');
  assert.equal(folds()[0].open,true);
  await p.api.watch(p.host,'lingguang');assert.equal(folds()[0].open,false);
});
test('answered questions keep their receipt and unanswered ones request new feedback',async()=>{
  const item=job('needs_review');item.data.questions=['项目？','负责人？'];
  item.data.resolutions=[{index:0,answer:'模拟项目'}];
  const p=page(async()=>response(data([item])));await p.api.watch(p.host,'lingguang');
  const elements=flatten(p.host);
  assert.ok(elements.some(n=>n.textContent==='已答复：项目？ · 模拟项目'));
  assert.ok(elements.some(n=>n.textContent==='需核对：负责人？'));
  assert.equal(elements.filter(n=>n.tag==='button').length,0);
});
test('retry keeps the same request ID after an uncertain response',async()=>{
  const posts=[];const p=page(async(url,options)=>{if(options){posts.push(options.body);throw new Error('lost response');}return response(data([job()]));});
  await p.api.watch(p.host,'lingguang');
  const retry=flatten(p.host).find(n=>n.tag==='button');
  await retry.onclick();await retry.onclick();
  assert.equal(posts.length,2);assert.equal(posts[0],posts[1]);
  assert.ok(flatten(p.host).some(n=>n.textContent.includes('<script>text only</script>')));
});
test('a slow response from the previous note cannot replace the current panel',async()=>{
  let resolve;const slow=new Promise(r=>resolve=r);let calls=0;
  const p=page(async()=>++calls===1?slow:response(data([])));
  const old=p.api.watch(p.host,'lingguang','old');
  await p.api.watch(p.host,'lumos','new');const before=p.host.children.slice();
  resolve(response(data([job('running')])));await old;
  assert.deepEqual(p.host.children,before);assert.equal(p.timers.size,0);
});
test('editing cancels polling without mutating the note',async()=>{
  const p=page(async()=>response(data([job('running')])));
  await p.api.watch(p.host,'lingguang');assert.equal(p.timers.size,1);
  p.api.stop();assert.equal(p.timers.size,0);
});
test('a completed background job refreshes the reading view once',async()=>{
  let calls=0,finished=0;
  const p=page(async()=>response(data([job(++calls===1?'running':'done')])));
  await p.api.watch(p.host,'lingguang',null,async()=>{finished++;});
  assert.equal(finished,0);
  await [...p.timers.values()][0]();
  assert.equal(finished,1);
});

test('receipt updates report pending, failed reads and recovery without losing polling',async()=>{
  let count=0;const updates=[];
  const p=page(async()=>{if(++count===2)throw new Error('offline');return response(data([job(count===1?'pending':'done')]));});
  await p.api.watch(p.host,'lingguang',null,null,d=>updates.push(d));
  await [...p.timers.values()][0]();
  assert.equal(updates[0].intakes[0].data.status,'pending');assert.equal(updates[1],null);
  await [...p.timers.values()].at(-1)();assert.equal(updates[2].intakes[0].data.status,'done');
});

test('feedback older than ten entries remains readable with subject, time and full original text',async()=>{
  const jobs=Array.from({length:12},(_,i)=>({...job('done'),id:'job-'+i,data:{...job('done').data,text:'原文 '+i,created_at:'2026-11-16T01:00:00Z',summary:'处理 '+i},subjects:[{title:'对应任务 '+i}]}));
  const p=page(async()=>response(data(jobs)));await p.api.watch(p.host,'lingguang');
  const elements=flatten(p.host);
  assert.ok(elements.some(n=>n.textContent==='我的反馈：原文 11'));
  assert.ok(elements.some(n=>n.textContent.includes('对应任务 11 · 已整理 · 2026/11/16')));
  assert.ok(elements.some(n=>n.textContent==='Lumos 处理结果：处理 11'));
});

test('automatic reviews are distinguished from user feedback',async()=>{
  const item=job('done');item.data.review={id:'mainline-test'};item.data.text='没有新增用户进展';item.subjects=[{title:'模拟主线'}];
  const p=page(async()=>response(data([item])));await p.api.watch(p.host,'lingguang');
  const elements=flatten(p.host);
  assert.ok(elements.some(n=>n.textContent==='系统复核说明：没有新增用户进展'));
  assert.ok(elements.some(n=>n.textContent.includes('模拟主线 · 到期复核 · 已整理')));
  assert.ok(!elements.some(n=>n.textContent.startsWith('我的反馈：')));
});
