const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {chatTurns,chatReceipt,suggestedTasks}=require('../web/chat.js');
const tick=()=>new Promise(r=>setImmediate(r));
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
class Element{
  constructor(){this.value='';this.children=[];this.scrollHeight=500;this.scrollTop=400;this.clientHeight=100;}
  append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}setAttribute(k,v){this[k]=v;}focus(){}
}
async function page(storage=new Map(),href='http://127.0.0.1/chat?id='+'a'.repeat(32),initial=[],board={}){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
  const listing={intakes:initial,token:'test',enabled:true,executor:'available'},posts=[];
  const world={document:{getElementById:get,createElement:()=>new Element()},window:{location:{href}},history:{replaceState(a,b,u){world.window.location.href=String(u);}},URL,crypto,
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},setTimeout:()=>1,clearTimeout(){},
    fetch:async(url,opts)=>{if(!opts)return response(url==='/api/codex-models'?{models:[{id:'test-model',name:'Test model'}]}:url==='/api/tasks'?board:listing);const req=JSON.parse(opts.body);posts.push(req);const intake={id:'intake-'+req.request_id,data:{...req,status:'pending',revision:1,created_at:'2026-11-17T00:00:00Z'}};listing.intakes.unshift(intake);return response({intake});}};
  vm.createContext(world);vm.runInContext(fs.readFileSync('web/chat.js','utf8'),world);await tick();
  const edit=text=>{get('chat-text').value=text;get('chat-text').oninput();};
  const submit=async()=>{get('chat-form').onsubmit({preventDefault(){}});await tick();};
  return {world,get,listing,posts,edit,submit,storage};
}
test('conversation ordering uses parent links and reports actual saved targets',()=>{
  const first={id:'1',data:{chat_id:'c',status:'done'}},next={id:'2',data:{chat_id:'c',chat_parent:'1',status:'done'},targets:[{kind:'action'}]};
  assert.deepEqual(chatTurns([next,first,{id:'other',data:{chat_id:'other'}}],'c'),[first,next]);
  assert.match(chatReceipt(first),/仅讨论/);assert.match(chatReceipt(next),/已保存 1 项/);
});
test('send includes chosen model, clears acknowledged text, blocks concurrent turns and renders safely',async()=>{
  const p=await page();p.get('chat-model').value='test-model';p.edit('<script>progress</script>');await p.submit();
  assert.equal(p.posts.length,1);assert.equal(p.posts[0].model,'test-model');assert.equal(p.posts[0].chat_parent,'');
  assert.equal(p.get('chat-text').value,'');p.edit('next');await p.submit();assert.equal(p.posts.length,1);
  const user=p.get('messages').children[0].children[0];assert.equal(user.children[1].textContent,'<script>progress</script>');
});
test('uncertain send survives reload and retries the same payload',async()=>{
  const p=await page();const normal=p.world.fetch;let original;
  p.world.fetch=async(url,opts)=>{if(opts){original=JSON.parse(opts.body);throw new Error('lost response');}return normal(url,opts);};
  p.edit('important progress');await p.submit();assert.equal(p.get('chat-text').readOnly,true);assert.equal(p.get('send-chat').disabled,false);
  const q=await page(p.storage,p.world.window.location.href);q.edit('cannot replace uncertain input');await q.submit();
  assert.deepEqual(q.posts[0],original);assert.equal(q.get('chat-text').value,'');
});
test('confirmed rejection keeps draft editable and uses fresh request after correction',async()=>{
  const p=await page();const normal=p.world.fetch;let rejected;
  p.world.fetch=async(url,opts)=>{if(opts){rejected=JSON.parse(opts.body);return response({error:'stale conversation'},409);}return normal(url,opts);};
  p.edit('first draft');await p.submit();assert.equal(p.get('chat-text').value,'first draft');assert.equal(p.get('chat-text').readOnly,false);
  p.world.fetch=normal;p.edit('corrected');await p.submit();assert.notEqual(p.posts[0].request_id,rejected.request_id);assert.equal(p.posts[0].text,'corrected');
});
test('workspace switching preserves drafts and does not reuse another chat parent',async()=>{
  const p=await page();p.edit('lingguang draft');p.get('chat-workspace').value='lumos';await p.get('chat-workspace').onchange();
  assert.equal(p.get('chat-text').value,'');p.edit('maintenance');await p.submit();assert.equal(p.posts[0].workspace,'lumos');assert.equal(p.posts[0].chat_parent,'');
  const q=await page(p.storage);assert.equal(q.get('chat-text').value,'lingguang draft');
});
test('returning through navigation restores the current unsent conversation',async()=>{
  const p=await page();p.edit('unfinished thought');
  const q=await page(p.storage,'http://127.0.0.1/chat');assert.equal(q.get('chat-text').value,'unfinished thought');
  q.get('new-chat').onclick();assert.equal(q.get('chat-text').value,'unfinished thought');
});
const task=(id,data={})=>({id,short_id:'T-'+id,data:{context:'work',text:'任务'+id,status:'doing',due:'2026-11-18',...data}});
const board=tasks=>({today:'2026-11-17',contexts:[{id:'work',data:{workspace:'lingguang'}},{id:'maintenance',data:{workspace:'lumos'}},{id:'archive',data:{status:'archived'}}],tasks,mainlines:[{data:{milestone_ids:['stage']}}]});
const descendants=n=>[n,...n.children.flatMap(descendants)];
test('task hints separate recent delivery from overdue, exclude closed and other spaces, and prioritize milestones on the same date',()=>{
  const data=board([task('z'),task('stage'),task('late',{due:'2026-11-16',planned_due:'2026-11-22'}),task('internal',{due:'',planned_due:'2026-11-30'}),task('future',{due:'2026-12-02'}),task('done',{status:'done'}),task('cancelled',{status:'cancelled'}),task('other',{context:'maintenance'}),task('archived',{context:'archive'}),task('long',{due:'long_term'}),task('follow-only',{due:'',follow_up:'2026-11-18'})]);
  const before=JSON.stringify(data),result=suggestedTasks(data,'lingguang');
  assert.deepEqual(result.upcoming.map(t=>t.id),['stage','z','internal']);assert.equal(result.upcoming[2].dateLabel,'Lumos目标');
  assert.deepEqual(result.overdue.map(t=>t.id),['late']);assert.equal(result.overdue[0].date,'2026-11-16');assert.equal(JSON.stringify(data),before);
});
test('selecting tasks preserves original words and restored selections are submitted as exact references',async()=>{
  const p=await page(new Map(),undefined,[],board([task('one')]));p.edit('一大段原始进展\n尚无结果');
  descendants(p.get('messages')).find(n=>n.className==='task-prompt').onclick();
  assert.equal(p.posts.length,0);assert.equal(p.get('chat-text').value,'一大段原始进展\n尚无结果');
  const q=await page(p.storage,p.world.window.location.href,[],board([task('one')]));assert.equal(q.get('selected-tasks').children.length,1);
  await q.submit();assert.deepEqual(q.posts[0].related_ids,['one']);assert.equal(q.posts[0].text,'一大段原始进展\n尚无结果');assert.equal(q.get('selected-tasks').children.length,0);
});
test('expanding and collapsing writing preserve long text and task choices can be removed without changing it',async()=>{
  const p=await page(new Map(),undefined,[],board([task('one')]));const text='完整进展\n'.repeat(100);p.edit(text);
  descendants(p.get('messages')).find(n=>n.className==='task-prompt').onclick();p.get('expand-writing').onclick();assert.equal(p.get('conversation')['data-writing'],'expanded');
  p.get('selected-tasks').children[0].onclick();p.get('expand-writing').onclick();assert.equal(p.get('conversation')['data-writing'],'normal');assert.equal(p.get('chat-text').value,text);
  await p.submit();assert.deepEqual(p.posts[0].related_ids,[]);
});
test('task selections remain with their workspace draft',async()=>{
  const p=await page(new Map(),undefined,[],board([task('one')]));descendants(p.get('messages')).find(n=>n.className==='task-prompt').onclick();p.edit('draft');
  p.get('chat-workspace').value='lumos';await p.get('chat-workspace').onchange();assert.equal(p.get('selected-tasks').children.length,0);
  p.get('chat-workspace').value='lingguang';await p.get('chat-workspace').onchange();assert.equal(p.get('selected-tasks').children.length,1);assert.equal(p.get('chat-text').value,'draft');
});
test('retrying a failed turn does not erase the next long-form draft',async()=>{
  const first={id:'failed-turn',data:{chat_id:'a'.repeat(32),text:'上一轮原话',title:'讨论',status:'failed',revision:3,created_at:'2026-11-17T00:00:00Z'}};
  const p=await page(new Map(),undefined,[first]);p.edit('下一段尚未发送的进展\n需要保留');p.get('expand-writing').onclick();
  await descendants(p.get('messages')).find(n=>n.textContent==='重试本轮').onclick();
  assert.equal(p.posts[0].id,'failed-turn');assert.equal(p.get('chat-text').value,'下一段尚未发送的进展\n需要保留');assert.equal(p.get('conversation')['data-writing'],'expanded');
});
