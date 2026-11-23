const test=require('node:test'),assert=require('node:assert/strict');
const {attentionThreads,noticeText}=require('../web/attention.js');
const {pageRole,roleSpaces}=require('../web/role-navigation.js');
const chat=(role,id,notices,extra={})=>({data:{agent_role:role,chat_id:id,title:id,workspace:'lingguang',notices,...extra}});
const notice=(id,extra={})=>({id,text:id,active:true,seen_at:'',at:'2026-11-22',...extra});
test('Ops audit references read as a receipt count without changing the original message or business text',()=>{
  const first='intake-'+'a'.repeat(32),second='intake-'+'b'.repeat(32);
  const item={kind:'ops',text:`整理执行器调用了计划外工具，结果未应用。\nOps 核对结果：后续已保存并涉及此主线的回执：${first}、${second}、${first}。还需确认权限。`,active:false,seen_at:'read'};
  const before=JSON.stringify(item),text=noticeText(item);
  assert.match(text,/已核对 2 条相关的后续处理记录/);assert.match(text,/还需确认权限/);assert.doesNotMatch(text,/intake-/);
  assert.equal(JSON.stringify(item),before);assert.equal(noticeText({...item,kind:'question'}),item.text);
  assert.equal(noticeText({kind:'ops',text:'请核对 '+first+' 的权限；当前仍失败。'}),'请核对 关联处理记录 的权限；当前仍失败。');
  assert.match(noticeText({kind:'ops',text:'后续已保存并涉及此主线的回执：未找到后续回执。'}),/当时未找到/);
  assert.match(noticeText({kind:'ops',text:'后续已保存并涉及此主线的回执：'+first+'，但内容冲突。'}),/但内容冲突/);
});
test('Ops recovery notification keeps its limited claim and does not imply permanent repair',()=>{
  const text=noticeText({kind:'ops',text:'运行情况已更新：该次处理已成功接续；不代表底层故障已永久修复。'});
  assert.match(text,/无需为此重新提交/);assert.match(text,/不代表同类故障已永久排除/);
  assert.equal(noticeText({kind:'ops',text:'权限尚未恢复，需要你授权。'}),'权限尚未恢复，需要你授权。');
});
test('each role counts only its own active unread messages and retains its read history',()=>{
  const chats=[chat('lumos','l',[notice('l1'),notice('l2')]),chat('aipm','a',[notice('a1')]),
    chat('librarian','t',[notice('t1',{seen_at:'read'})]),chat('maintainer','o',[notice('o1'),notice('old',{active:false})]),
    chat('aipm','deleted',[notice('d')],{deleted:true})];
  for(const [role,total] of [['lumos',2],['aipm',1],['librarian',0],['maintainer',1]]){
    const rows=attentionThreads(chats,role);assert.ok(rows.every(n=>n.role===role));assert.equal(rows.reduce((n,r)=>n+r.unread,0),total);
  }
  chats[1].data.notices[0].seen_at='read';
  assert.equal(attentionThreads(chats,'aipm')[0].unread,0);assert.equal(attentionThreads(chats,'lumos')[0].unread,2);
});
function inbox(url){
  class Element{
    constructor(){this.children=[];this.attrs={};this.textContent='';this.classList={toggle(){}};}
    append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}setAttribute(k,v){this.attrs[k]=v;}addEventListener(){}showModal(){}close(){}
  }
  const requests=[],events={},body=new Element(),world={document:{body,createElement:()=>new Element()},
    window:{addEventListener:(k,fn)=>events[k]=fn},location:new URL(url),URL,roleSpaces,pageRole,
    clearTimeout(){},setTimeout(){},fetch:url=>new Promise(resolve=>requests.push({url,resolve}))};
  require('node:vm').runInNewContext(require('node:fs').readFileSync('web/attention.js','utf8'),world);
  return {world,requests,events,trigger:body.children[0],panel:body.children[1]};
}
const finish=async(request,chats)=>{request.resolve({ok:true,json:async()=>({conversations:chats})});await new Promise(resolve=>setImmediate(resolve));};
test('role pages and legacy URLs show matching inboxes without marking other roles read',async()=>{
  const chats=Object.keys(roleSpaces).map(r=>chat(r,r,[notice(r)]));
  for(const [path,role] of [['/','lumos'],['/tasks','aipm'],['/notes','librarian'],['/agents','maintainer'],['/chat?agent=aipm','aipm']]){
    const p=inbox('http://localhost'+path);await finish(p.requests[0],chats);
    assert.equal(p.trigger.textContent,'消息 · 1 未读');assert.equal(p.panel.children[0].children[0].textContent,roleSpaces[role].name+' 的消息');
    assert.equal(p.panel.children[1].children.length,1);assert.equal(p.panel.children[1].children[0].children[1].textContent,role);
    assert.equal(p.requests.length,1);assert.ok(p.requests[0].url.startsWith('/api/conversations?'));
  }
});
test('a slow old response cannot overwrite the newly selected role or empty-state label',async()=>{
  const p=inbox('http://localhost/chat?role=lumos');
  p.world.location.search='?role=aipm';p.events['lumos-role']();
  await finish(p.requests[1],[]);await finish(p.requests[0],[chat('lumos','l',[notice('l')])]);
  assert.equal(p.trigger.textContent,'消息');assert.equal(p.trigger.attrs['aria-label'],'消息，无未读');
  assert.equal(p.panel.children[1].children[0].textContent,'AIPM 暂时没有新消息。');
  p.world.location.search='?role=maintainer';p.events['lumos-role']();await finish(p.requests[2],[]);
  assert.equal(p.panel.children[1].children[0].textContent,'Ops 暂时没有新消息。');
});
test('Ops message preview uses the same readable text as the chat',async()=>{
  const p=inbox('http://localhost/agents'),item=notice('o',{kind:'ops',text:'后续已保存并涉及此主线的回执：intake-'+'a'.repeat(32)+'。'});
  await finish(p.requests[0],[chat('maintainer','ops',[item])]);
  assert.equal(p.panel.children[1].children[0].children[2].textContent,noticeText(item));
});

test('read unanswered, processing, retry and settled states remain distinct',()=>{
  const {conversationState}=require('../web/attention.js');
  const data={topic_state:'settled',notices:[{active:true,kind:'followup',seen_at:''}]};
  assert.equal(conversationState(data).key,'unread');data.notices[0].seen_at='read';assert.equal(conversationState(data).key,'awaiting');
  assert.equal(conversationState(data,{status:'running'}).key,'processing');assert.equal(conversationState(data,{status:'failed'}).key,'failed');
  data.notices[0].active=false;assert.equal(conversationState(data).key,'settled');data.awaiting_reply=true;assert.equal(conversationState(data).key,'awaiting');
});
