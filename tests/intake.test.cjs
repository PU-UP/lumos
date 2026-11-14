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
