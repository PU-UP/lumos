const test=require('node:test'),assert=require('node:assert/strict');
const {attentionThreads}=require('../web/attention.js');
const {pageRole,roleSpaces}=require('../web/role-navigation.js');
const chat=(role,id,notices,extra={})=>({data:{agent_role:role,chat_id:id,title:id,workspace:'lingguang',notices,...extra}});
const notice=(id,extra={})=>({id,text:id,active:true,seen_at:'',at:'2026-11-22',...extra});
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
