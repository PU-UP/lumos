const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {chatTurns,chatReceipt,discussionItems,discussionQuestions}=require('../web/role-chat.js');
const tick=()=>new Promise(r=>setImmediate(r));
const response=(data,status=200)=>({ok:status===200,status,json:async()=>data});
class Element{
  constructor(){this.value='';this.children=[];this.scrollHeight=500;this.scrollTop=400;this.clientHeight=100;this.events={};this.dataset={};}
  addEventListener(name,fn){this.events[name]=fn;}
  querySelectorAll(){return descendants(this).filter(n=>n.dataset.noticeId);}
  showModal(){this.open=true;}close(){this.open=false;this.onclose?.();}
  append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}setAttribute(k,v){this[k]=v;}focus(){}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
const choiceJob=()=>({id:'choice-job',question_options:[{index:0,options:[{text:'属于模拟建图定位',available:true},{text:'属于模拟入职准备',available:false}]}],
  data:{chat_id:'a'.repeat(32),agent_role:'aipm',title:'确认归属',text:'准备资料',reply:'请确认归属。',status:'needs_review',questions:['这件事属于哪个项目？'],created_at:'2026-11-21T00:00:00Z'}});
test('choosing an answer preserves prose, survives reload and submits the exact original question once',async()=>{
  const job=choiceJob(),storage=new Map(),p=await page(storage,undefined,[job]);p.edit('补充原话，不要丢失');
  const choices=descendants(p.get('messages')).filter(n=>n.className==='clarification-option');
  assert.equal(choices[1].disabled,true);choices[0].onclick();assert.equal(p.posts.length,0);assert.equal(p.get('chat-text').value,'补充原话，不要丢失');
  assert.equal(p.get('chat-text').required,false);
  const q=await page(storage,p.world.window.location.href,[job]);await q.submit();
  assert.equal(q.posts[0].text,'属于模拟建图定位\n\n补充原话，不要丢失');assert.equal(q.posts[0].question_key,'question:choice-job:0');
  assert.equal(q.posts[0].question_text,job.data.questions[0]);assert.equal(q.posts[0].chat_parent,job.id);
  assert.ok(descendants(q.get('messages')).some(n=>n.textContent==='答复已提交 · 正在接续'));
  assert.ok(!descendants(q.get('messages')).some(n=>n.className==='clarification-option'));
});
test('choice-only answers can send, free input cancels the choice and resolved questions show no controls',async()=>{
  const job=choiceJob(),p=await page(new Map(),undefined,[job]);
  descendants(p.get('messages')).find(n=>n.className==='clarification-option').onclick();assert.equal(p.get('send-chat').disabled,false);
  descendants(p.get('messages')).find(n=>n.textContent==='自由补充').onclick();assert.equal(p.get('send-chat').disabled,true);assert.equal(p.get('chat-text').required,true);
  p.edit('不是这些项目，暂不创建任务');await p.submit();assert.equal(p.posts[0].text,'不是这些项目，暂不创建任务');
  const resolved={...job,data:{...job.data,resolutions:[{index:0,state:'resolved'}]}};
  const q=await page(new Map(),undefined,[resolved]);assert.ok(!descendants(q.get('messages')).some(n=>n.className==='clarification-option'||n.textContent==='自由补充'));
});
test('model preference persists per agent across new conversations, reload and explicit default',async()=>{
  const storage=new Map([['lumos.chat.model','test-model']]);
  const p=await page(storage,'http://127.0.0.1/chat?role=aipm');
  storage.set('lumos.chat.model.aipm','');p.events['lumos-model']();
  await p.get('new-chat').onclick();p.edit('新话题');await p.submit();assert.equal(p.posts.at(-1).model,'');
  const atlas=await page(storage,'http://127.0.0.1/chat?role=librarian');atlas.edit('查资料');await atlas.submit();assert.equal(atlas.posts.at(-1).model,'test-model');
  const again=await page(storage,'http://127.0.0.1/chat?role=aipm');again.edit('继续');await again.submit();assert.equal(again.posts.at(-1).model,'');
  storage.set('lumos.chat.model.aipm','test-model');
  const another=await page(storage,'http://127.0.0.1/chat?role=aipm&id='+'c'.repeat(32));another.edit('继续');await another.submit();assert.equal(another.posts[0].model,'test-model');
});
test('server-bound role selects its own model and missing models never silently fall back',async()=>{
  const storage=new Map([['lumos.chat.model.aipm','test-model'],['lumos.chat.model.librarian','previous-model']]);
  const id='a'.repeat(32),job={id:'old',data:{chat_id:id,agent_role:'librarian',workspace:'lingguang',title:'资料',text:'原话',created_at:'2026-11-20T00:00:00Z',status:'done'}};
  const p=await page(storage,'http://127.0.0.1/chat?role=aipm&id='+id,[job]);
  p.edit('继续');await p.submit();assert.equal(p.posts[0].model,'previous-model');
});
test('uncertain request retries keep the original model without replacing the agent preference',async()=>{
  const id='a'.repeat(32),pending={request_id:'request-one',chat_id:id,agent_role:'aipm',workspace:'lingguang',model:'original-model',text:'原消息'};
  const storage=new Map([['lumos.chat.model.aipm','test-model'],['lumos.chat.lingguang.'+id,JSON.stringify({pending,text:'原消息',agentRole:'aipm'})]]);
  const p=await page(storage,'http://127.0.0.1/chat?role=aipm&id='+id);
  await p.submit();assert.deepEqual(p.posts[0],pending);assert.equal(storage.get('lumos.chat.model.aipm'),'test-model');
});
test('role conversation actions fit the responsibility and starters never send or replace a draft',async()=>{
  for(const [role,resource] of [['librarian','查找资料'],['maintainer','运行问题']]){
    const p=await page(new Map(),'http://127.0.0.1/chat?role='+role);p.edit('保留我的原话');
    assert.equal(p.get('choose-subjects').hidden,true);assert.equal(p.get('role-resource').textContent,resource);
    const starters=descendants(p.get('messages')).find(n=>n.className==='conversation-starters');starters.children[0].onclick();
    assert.ok(p.get('chat-text').value.startsWith('保留我的原话\n\n'));assert.equal(p.posts.length,0);
  }
});
test('reply rendering removes duplicate receipts and trace links but keeps real questions actionable',async()=>{
  const job={id:'question-job',data:{chat_id:'a'.repeat(32),agent_role:'aipm',title:'进展讨论',text:'原话',reply:'请补充具体项目。\n- 保留原约定\n- 核对依赖',summary:'重复摘要',status:'needs_review',questions:['这件事属于哪个项目？'],related_ids:['task-one'],created_at:'2026-11-21T00:00:00Z'}};
  const p=await page(new Map(),undefined,[job]);const all=descendants(p.get('messages'));
  assert.ok(!all.some(n=>n.textContent==='查看处理经过'||n.textContent==='重复摘要'));
  const answer=all.find(n=>n.textContent==='补充答复');answer.onclick();
  assert.equal(p.posts.length,0);p.edit('属于已选中的项目');await p.submit();
  assert.equal(p.posts[0].question_key,'question:question-job:0');assert.deepEqual(p.posts[0].related_ids,['task-one']);
});
test('plain replies preserve untrusted text without injecting markup or losing list items',()=>{
  const {replyBlocks}=require('../web/role-chat.js');
  assert.deepEqual(replyBlocks('<script>danger()</script>\n\n- 第一条\n2. 第二条\n结果未知'),[
    {kind:'paragraph',text:'<script>danger()</script>'},{kind:'list',items:['第一条','第二条']},{kind:'paragraph',text:'结果未知'}]);
  const html=fs.readFileSync('web/role-chat.html','utf8');assert.ok(!html.includes('<details'));assert.ok(!html.includes('id="manage-conversation"'));assert.ok(html.includes('aria-label="重命名对话"'));
});

test('role entry drafts and active conversations do not leak across roles',async()=>{
  const storage=new Map();
  const p=await page(storage,'http://127.0.0.1/chat?role=aipm');p.edit('排期草稿');
  const q=await page(storage,'http://127.0.0.1/chat?role=librarian');assert.equal(q.get('chat-text').value,'');q.edit('资料草稿');
  const r=await page(storage,'http://127.0.0.1/chat?role=aipm');assert.equal(r.get('chat-text').value,'排期草稿');
  await r.submit();assert.equal(r.posts[0].agent_role,'aipm');assert.equal(r.posts[0].text,'排期草稿');
});
test('new conversation starts immediately in the same scope and retains the old draft',async()=>{
  const p=await page(new Map(),'http://127.0.0.1/chat?role=maintainer&workspace=lumos');p.edit('旧草稿');const old=p.world.window.location.href;await p.get('new-chat').onclick();
  assert.equal(p.posts.length,0);assert.equal(p.get('chat-text').value,'');assert.equal(p.get('chat-title').textContent,'新对话');
  p.edit('仅诊断');await p.submit();assert.equal(p.posts[0].agent_role,'maintainer');assert.equal(p.posts[0].workspace,'lumos');
  const q=await page(p.storage,old);assert.equal(q.get('chat-text').value,'旧草稿');
});
test('material handoff prepares an explicit read-only draft without sending again on reload',async()=>{
  const p=await page(new Map(),'http://127.0.0.1/chat?agent=librarian&material='+encodeURIComponent('条件.md'));
  assert.match(p.get('chat-text').value,/条件.md/);assert.match(p.get('chat-text').value,/只查阅/);assert.equal(p.posts.length,0);
  assert.equal(new URL(p.world.window.location.href).searchParams.has('material'),false);
});
test('a rejected rename can be corrected without replaying its rejected title',async()=>{
  const p=await page(),normal=p.world.fetch;p.get('session-title').value='被拒绝';p.get('session-title').oninput();
  p.world.fetch=async()=>response({error:'invalid'},400);await p.get('rename-form').onsubmit({preventDefault(){}});
  p.world.fetch=normal;p.get('session-title').value='修正标题';await p.get('rename-form').onsubmit({preventDefault(){}});
  assert.equal(p.posts[0].title,'修正标题');
});
test('server binding wins over an incorrect role in a bookmarked link',async()=>{
  const id='a'.repeat(32),job={id:'old',data:{chat_id:id,agent_role:'librarian',workspace:'lingguang',title:'旧资料',text:'旧原话',created_at:'2026-11-20T00:00:00Z',status:'done'}};
  const p=await page(new Map(),'http://127.0.0.1/chat?role=aipm&id='+id,[job]);
  assert.equal(p.get('role-heading').textContent,'Atlas');p.edit('继续核对');await p.submit();assert.equal(p.posts[0].agent_role,'librarian');
});
test('rename saves only the title and keeps the original message untouched',async()=>{
  const p=await page();p.edit('未发送原话');p.get('session-title').value='本轮目标';
  await p.get('rename-form').onsubmit({preventDefault(){}});assert.equal(p.posts[0].title,'本轮目标');assert.equal(p.posts[0].expected_revision,0);assert.equal(p.get('chat-text').value,'未发送原话');
  assert.equal('memo' in p.posts[0],false);assert.equal('status' in p.posts[0],false);
});
test('an uncertain rename stays with its own conversation after navigation and reload',async()=>{
  const p=await page();p.get('session-title').value='原对话';p.get('session-title').oninput();const normal=p.world.fetch;let attempted;
  p.world.fetch=async(url,opts)=>{if(url==='/api/conversations'){attempted=JSON.parse(opts.body);throw new Error('lost response');}return normal(url,opts);};
  await p.get('rename-form').onsubmit({preventDefault(){}});
  const q=await page(p.storage,'http://127.0.0.1/chat?role=librarian&id='+'b'.repeat(32));q.get('session-title').value='另一个对话';await q.get('rename-form').onsubmit({preventDefault(){}});assert.equal(q.posts[0].chat_id,'b'.repeat(32));
  const r=await page(p.storage,p.world.window.location.href);assert.equal(r.get('session-title').value,'原对话');await r.get('rename-form').onsubmit({preventDefault(){}});assert.deepEqual(r.posts[0],attempted);
});
async function page(storage=new Map(),href='http://127.0.0.1/chat?id='+'a'.repeat(32),initial=[],board={},extra={}){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
  const listing={conversations:[],intakes:initial,token:'test',enabled:true,executor:'available'},posts=[],notifications=[],events={};let poll,readTimer;
  const world={noticeText:require('../web/attention.js').noticeText,document:{getElementById:get,createElement:()=>new Element(),visibilityState:'visible',addEventListener(name,fn){events[name]=fn;}},window:{location:{href,origin:new URL(href).origin},parent:{postMessage(message){notifications.push(message);}},addEventListener(name,fn){events[name]=fn;},dispatchEvent(){}},history:{replaceState(a,b,u){world.window.location.href=String(u);}},URL,crypto,CustomEvent:class{constructor(name,options){this.detail=options?.detail;}},
    localStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},setTimeout:(fn,ms)=>{if(ms===1200)readTimer=fn;else poll=fn;return 1;},clearTimeout(){},
    fetch:async(url,opts)=>{if(!opts)return response(url==='/api/codex-models'?{models:[{id:'test-model',name:'Test model'}]}:url==='/api/tasks'?board:listing);const req=JSON.parse(opts.body);posts.push(req);if(url==='/api/conversation-read'){const conversation=listing.conversations.find(n=>n.data.chat_id===req.chat_id);conversation.data.notices.forEach(n=>{if(req.ids.includes(n.id))n.seen_at='seen';});return response({conversation});}if(url==='/api/conversations'&&req.operation){const conversation=listing.conversations.find(n=>n.data.chat_id===req.chat_id);conversation.data.deleted=req.operation==='delete';conversation.data.revision++;return response({conversation});}if(url==='/api/conversations'){const conversation={id:'chat-'+req.chat_id,kind:'conversation',data:{...req,revision:(req.expected_revision||0)+1,status:req.status||'active'}};listing.conversations=[conversation,...listing.conversations.filter(n=>n.id!==conversation.id)];return response({conversation});}const intake={id:'intake-'+req.request_id,data:{...req,status:'pending',revision:1,created_at:'2026-11-17T00:00:00Z'}};listing.intakes.unshift(intake);return response({intake});}};
  world.window.LumosModels={get:role=>require('../web/role-models.js').selectedRoleModel(role,world.localStorage),receipt:require('../web/role-models.js').receiptModel,loading:false,busy:false,error:''};
  Object.assign(world,extra);world.Event = Event;
  if(extra.parentModels)Object.assign(world.window.parent,{LumosModels:extra.parentModels,addEventListener(name,fn){events['parent:'+name]=fn;},removeEventListener(name){delete events['parent:'+name];}});
  vm.createContext(world);vm.runInContext(fs.readFileSync('web/dialog.js','utf8'),world);vm.runInContext(fs.readFileSync('web/work-model.js','utf8'),world);vm.runInContext(fs.readFileSync('web/role-chat.js','utf8'),world);await tick();
  const edit=text=>{get('chat-text').value=text;get('chat-text').oninput();};
  const submit=async()=>{get('chat-form').onsubmit({preventDefault(){}});await tick();};
  return {world,get,listing,posts,edit,submit,storage,notifications,events,poll:()=>poll(),read:()=>readTimer?.()};
}

test('open conversations receive model choices from the role work page without losing drafts',async()=>{
  const p=await page();p.edit('尚未发送的草稿');
  p.storage.set('lumos.chat.model.lumos','test-model');p.events.storage();
  assert.equal(p.get('chat-text').value,'尚未发送的草稿');
  await p.submit();assert.equal(p.posts.at(-1).model,'test-model');
});

test('chat uses saved server models and displays background pauses without losing the draft',async()=>{
  const p=await page();p.edit('保留未发送的正文');let selected='server-model';
  p.world.window.LumosModels={get:()=>selected,receipt:()=>selected,error:'',loading:false,busy:false,
    save:async(role,value)=>{assert.equal(role,'lumos');selected=value;}};
  p.events['lumos-model']();
  selected='changed';p.events['lumos-model']();
  for(const state of ['waiting','stopped']){p.listing.executor=state;await p.poll();assert.match(p.get('chat-status').textContent,/后台处理暂停或未运行/);}
  assert.equal(p.get('chat-text').value,'保留未发送的正文');await p.submit();assert.equal(p.posts[0].model,'changed');
});
test('embedded chat uses the page role model and blocks sending while that setting is unsettled',async()=>{
  let selected='page-model';const models={get:role=>role==='aipm'?selected:'other-role',loading:false,busy:false,error:''};
  const p=await page(new Map(),'http://127.0.0.1/chat?role=aipm&embedded=1',[],{},{parentModels:models});
  p.edit('保留草稿');models.busy=true;
  await p.submit();assert.equal(p.posts.length,0);assert.match(p.get('chat-status').textContent,/正在保存角色模型/);
  models.busy=false;models.error='设置保存失败';p.events['parent:lumos-model']();await p.submit();assert.equal(p.posts.length,0);
  models.error='';selected='new-page-model';p.events['parent:lumos-model']();assert.equal(p.get('chat-text').value,'保留草稿');
  await p.submit();assert.equal(p.posts.at(-1).model,'new-page-model');assert.equal(p.posts.at(-1).agent_role,'aipm');
  p.events.pagehide();assert.equal(p.events['parent:lumos-model'],undefined);
  const html=fs.readFileSync('web/role-chat.html','utf8');assert.ok(!html.includes('id="chat-model"'));assert.ok(!html.includes('id="model-help"'));
});

test('unified workspace hides obsolete scope labels without changing drafts',async()=>{
  const p=await page();p.edit('统一工作区草稿');p.world.window.LumosUnified=true;
  await p.poll();assert.equal(p.get('conversation-scope').textContent,'');assert.equal(p.get('conversation-scope').hidden,true);
  assert.equal(p.get('chat-text').value,'统一工作区草稿');await p.submit();assert.equal(p.posts[0].workspace,'lingguang');
});

test('embedded chat notifies the overview only after a newly completed turn, not on opening history',async()=>{
  const job=choiceJob(),href='http://127.0.0.1/chat?role=aipm&embedded=1&id='+job.data.chat_id;
  const history=await page(new Map(),href,[job]);assert.equal(history.notifications.length,0);
  const p=await page(new Map(),href,[{...job,data:{...job.data,status:'pending'}}]);
  p.listing.intakes=[job];await p.poll();assert.equal(p.notifications.length,1);assert.equal(p.notifications[0].lumosChat,'saved');
  await p.poll();assert.equal(p.notifications.length,1);
});


test('proactive messages never mark themselves read in a hidden or polling chat and answer the exact question',async()=>{
  const p=await page(),id='a'.repeat(32),item={id:'notice-one',kind:'question',text:'实测结果是什么？',at:'2026-11-22T01:00:00Z',active:true,seen_at:'',question_key:'question:original:0',related_ids:['talk']};
  p.listing.conversations=[{id:'chat-'+id,data:{chat_id:id,title:'同步进展',agent_role:'lumos',workspace:'lingguang',status:'active',notices:[item]}}];
  await p.poll();await p.poll();assert.equal(p.posts.length,0);
  const normal=p.world.fetch;p.world.fetch=async(url,opts)=>{if(url==='/api/conversation-read'){const req=JSON.parse(opts.body);assert.deepEqual(req.ids,['notice-one']);p.listing.conversations[0].data.notices[0].seen_at='2026-11-22T02:00:00Z';return response({conversation:p.listing.conversations[0]});}return normal(url,opts);};
  p.edit('保留我的补充');descendants(p.get('messages')).find(n=>n.textContent==='答复').onclick();await tick();
  assert.equal(p.get('chat-text').value,'保留我的补充');await p.submit();assert.equal(p.posts[0].question_key,'question:original:0');assert.deepEqual(p.posts[0].related_ids,['talk']);
});

test('message inbox sorts unread first and retains settled topics without counting stale prompts',()=>{
  const {attentionThreads}=require('../web/attention.js');
  const chat=(id,notices)=>({data:{chat_id:id,agent_role:'lumos',workspace:'lingguang',title:id,notices}});
  const result=attentionThreads([chat('read',[{active:true,seen_at:'seen',at:'2026-11-23'}]),chat('old',[{active:false,seen_at:'',at:'2026-11-24'}]),chat('unread',[{active:true,seen_at:'',at:'2026-11-22'}])]);
  assert.deepEqual(result.map(n=>[n.id,n.unread]),[['unread',1],['old',0],['read',0]]);
});
test('Ops chat shows readable history and can continue the exact incident without requiring a reply',async()=>{
  const p=await page(),id='a'.repeat(32),source='intake-'+'b'.repeat(32),item={id:'ops-notice',kind:'ops',source_id:source,related_ids:[],text:'后续已保存并涉及此主线的回执：'+source+'。',at:'2026-11-22T01:00:00Z',active:true,seen_at:'read'};
  p.listing.conversations=[{id:'chat-'+id,data:{chat_id:id,title:'运行检查',agent_role:'maintainer',workspace:'lingguang',status:'active',notices:[item]}}];
  await p.poll();const all=descendants(p.get('messages'));
  assert.ok(all.some(n=>n.textContent==='已核对 1 条相关的后续处理记录。'));
  assert.ok(!all.some(n=>n.textContent==='答复'||n.textContent?.includes(source)));
  assert.equal(p.posts.length,0);all.find(n=>n.textContent==='继续聊').onclick();
  assert.equal(p.get('episode-reference').textContent,'正在接续：运行检查');
  p.edit('这次异常是否需要我处理？');await p.submit();assert.equal(p.posts.at(-1).episode_ref,source);
  assert.equal(item.text,'后续已保存并涉及此主线的回执：'+source+'。');
});


test('automatic reading requires visible message endings in a visible tab and leaves unseen messages unread',async()=>{
  const observers=[];class Observer{constructor(callback){this.callback=callback;this.targets=[];observers.push(this);}observe(n){this.targets.push(n);}disconnect(){}}
  const p=await page(new Map(),undefined,[],{}, {IntersectionObserver:Observer}),id='a'.repeat(32);
  const message=(key)=>({id:key,kind:'question',text:key,at:'2026-11-22T01:00:00Z',active:true,seen_at:'',related_ids:[]});
  p.listing.conversations=[{id:'chat-'+id,data:{chat_id:id,title:'进展',agent_role:'lumos',workspace:'lingguang',status:'active',notices:[message('visible'),message('below-fold')]}}];await p.poll();
  const observer=observers.at(-1);p.world.document.visibilityState='hidden';observer.callback([{target:observer.targets[0],isIntersecting:true,intersectionRatio:1}]);await p.read();assert.equal(p.posts.length,0);
  p.world.document.visibilityState='visible';p.get('conversation').inert=true;p.events.visibilitychange();await p.read();assert.equal(p.posts.length,0);
  p.get('conversation').inert=false;p.events['lumos-chat-visibility']();await p.read();await tick();assert.deepEqual(p.posts[0].ids,['visible']);
  assert.equal(p.listing.conversations[0].data.notices[1].seen_at,'');
});

test('conversation labels use Shanghai creation dates without changing explicit names or inventing legacy dates',()=>{
  const {conversationLabel}=require('../web/role-chat.js');
  assert.equal(conversationLabel('联调准备','2026-11-21T17:00:00Z'),'2026-11-22 | 联调准备');
  assert.equal(conversationLabel('2026-11-20 | 自定主题','2026-11-21T17:00:00Z'),'2026-11-20 | 自定主题');
  assert.equal(conversationLabel('旧话题',undefined),'旧话题');
  assert.equal(conversationLabel('新对话','invalid'),'新对话');
});

test('delete confirmation preserves task history, removes old chat from list and restores its draft on undo',async()=>{
  const p=await page(),id='a'.repeat(32);
  p.listing.conversations=[{id:'chat-'+id,data:{chat_id:id,title:'同步资料',created_at:'2026-11-22T00:00:00Z',agent_role:'lumos',workspace:'lingguang',revision:1,status:'active'}}];
  await p.poll();p.edit('未发送补充');
  const remove=()=>descendants(p.get('chat-list')).find(n=>n.className==='chat-delete');
  remove().onclick();assert.equal(p.posts.length,0);p.get('cancel-chat-delete').onclick();assert.equal(p.get('delete-conversation').open,false);
  remove().onclick();await p.get('confirm-chat-delete').onclick();
  assert.equal(p.posts[0].operation,'delete');assert.equal(p.posts[0].confirmed,true);
  assert.equal(descendants(p.get('chat-list')).some(n=>n.textContent==='2026-11-22 | 同步资料'),false);
  assert.equal(p.get('chat-text').value,'');
  await p.get('undo-chat-delete').onclick();assert.equal(p.posts[1].operation,'restore');assert.equal(p.get('chat-text').value,'未发送补充');
});

test('sidebar search keeps the active draft and deleted chats stay out of the message inbox',async()=>{
  const p=await page(),id='a'.repeat(32),chat={id:'chat-'+id,data:{chat_id:id,title:'同步资料',created_at:'2026-11-22T00:00:00Z',agent_role:'lumos',workspace:'lingguang',revision:1,status:'active',notices:[{id:'n',kind:'reply',text:'已整理',active:true,seen_at:'',at:'2026-11-22'}]}};
  p.listing.conversations=[chat];await p.poll();p.edit('别丢掉草稿');
  p.get('chat-search').value='no match';p.get('chat-search').oninput();assert.equal(descendants(p.get('chat-list')).some(n=>n.textContent==='没有找到匹配的对话。'),true);assert.equal(p.get('chat-text').value,'别丢掉草稿');
  p.get('chat-search').value='2026-11-22';p.get('chat-search').oninput();assert.equal(descendants(p.get('chat-list')).find(n=>n.className==='chat-link').dataset.unread,'true');
  const {attentionThreads}=require('../web/attention.js');assert.equal(attentionThreads([{...chat,data:{...chat.data,deleted:true}}]).length,0);
});

const managedChat=(id,title,role='lumos',notices=[])=>({id:'chat-'+id,kind:'conversation',data:{chat_id:id,title,agent_role:role,workspace:'lingguang',status:'active',revision:1,created_at:'2026-11-23T01:00:00Z',notices}});
test('batch read covers only selected role conversations, chunks receipts, and never submits a reply',async()=>{
  const p=await page(),a='a'.repeat(32),b='b'.repeat(32),o='c'.repeat(32);
  p.listing.conversations=[managedChat(a,'甲','lumos',Array.from({length:201},(_,i)=>({id:String(i),kind:'reply',active:true,seen_at:''}))),managedChat(b,'乙','lumos',[{id:'b',kind:'reply',active:true,seen_at:''}]),managedChat(o,'其他角色','maintainer',[{id:'o',kind:'reply',active:true,seen_at:''}])];
  await p.poll();p.get('select-chats').onclick();assert.equal(p.get('chat-selection-count').textContent,'已选 2 项');
  await p.get('read-selected-chats').onclick();assert.deepEqual(p.posts.map(r=>[r.chat_id,r.ids.length]),[[a,200],[a,1],[b,1]]);
  assert.equal(p.listing.conversations[2].data.notices[0].seen_at,'');assert.equal(p.listing.intakes.length,0);assert.equal(p.get('chat-selection-count').textContent,'已选 0 项');
});
test('batch deletion confirms exact titles, retries only unfinished items, and undo restores every draft',async()=>{
  const p=await page(),a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
  p.listing.conversations=[managedChat(a,'甲'),managedChat(b,'乙'),managedChat(c,'丙')];await p.poll();p.edit('甲的草稿');p.storage.set('lumos.chat.lingguang.'+b,JSON.stringify({text:'乙的草稿'}));
  p.get('select-chats').onclick();p.get('delete-selected-chats').onclick();assert.equal(p.posts.length,0);assert.match(p.get('delete-chat-name').textContent,/甲[\s\S]*乙[\s\S]*丙/);
  const normal=p.world.fetch,attempts=[];let fail=true;
  p.world.fetch=async(url,opts)=>{if(opts&&url==='/api/conversations'){const r=JSON.parse(opts.body);if(r.operation==='delete'){attempts.push(r);if(r.chat_id===b&&fail)return response({error:'连接中断'},503);}}return normal(url,opts);};
  await p.get('confirm-chat-delete').onclick();assert.equal(p.listing.conversations.find(n=>n.data.chat_id===a).data.deleted,true);assert.match(p.get('delete-chat-error').textContent,/已删除 1 段/);
  fail=false;await p.get('confirm-chat-delete').onclick();assert.equal(attempts.filter(r=>r.chat_id===a).length,1);const second=attempts.filter(r=>r.chat_id===b);assert.equal(second[0].request_id,second[1].request_id);
  assert.ok(p.listing.conversations.every(n=>n.data.deleted));await p.get('undo-chat-delete').onclick();assert.ok(p.listing.conversations.every(n=>!n.data.deleted));
  assert.equal(p.get('chat-text').value,'甲的草稿');assert.equal(JSON.parse(p.storage.get('lumos.chat.lingguang.'+b)).text,'乙的草稿');
});
test('batch deletion refuses running conversations and list reply opens without sending',async()=>{
  const p=await page(),a='a'.repeat(32),b='b'.repeat(32);p.listing.conversations=[managedChat(a,'甲'),managedChat(b,'乙')];p.listing.intakes=[{id:'running',data:{chat_id:a,agent_role:'lumos',status:'running',created_at:'2026-11-23'}}];await p.poll();
  p.get('select-chats').onclick();p.get('delete-selected-chats').onclick();await p.get('confirm-chat-delete').onclick();assert.equal(p.posts.length,0);assert.match(p.get('delete-chat-error').textContent,/仍在处理/);
  await descendants(p.get('chat-list')).find(n=>n['aria-label']==='回复：2026-11-23 | 乙').onclick();assert.ok(p.world.window.location.href.includes(b));assert.equal(p.posts.length,0);
});
