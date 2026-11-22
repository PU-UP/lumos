const test=require('node:test'),assert=require('node:assert/strict');
const {briefItems}=require('../web/overview.js');
const {trustedChatMessage,chatDockWidth,chatDockPreference}=require('../web/workspace.js');
const {roleSpaces}=require('../web/role-navigation.js');
test('brief groups a shared question once without copying tasks into more sections',()=>{
  const task={id:'t',data:{text:'标定',status:'todo'}},other={id:'o',data:{text:'独立事项',status:'doing'}};
  const line={id:'p',data:{title:'联调'}};
  const q={key:'q',line,tasks:[task],title:'联调',text:'谁来执行？'};
  const items=briefItems({entries:[{line,tasks:[task]},{line:{id:'p2',data:{title:'另一主线'}},tasks:[task]}],independent:[other]}, {primary:[q],rest:[]});
  assert.equal(items.reduce((sum,i)=>sum+i.questions.length,0),1);
  assert.equal(items[0].id,'p');assert.equal(items.at(-1).id,'o');
});
test('unlinked questions stay visible and future-only questions do not become current requests',()=>{
  const q={key:'q',title:'哪项?',text:'哪项?',tasks:[]};
  const items=briefItems({entries:[],independent:[]},{primary:[q],rest:[],later:[{...q,key:'future'}]});
  assert.equal(items.length,1);assert.equal(items[0].title,'需要你确认');
});

test('answers remain with exact work items through processing and settlement, including newly created tasks',()=>{
  const task={id:'t',data:{text:'整理资料',status:'todo'}},model={entries:[],independent:[task]};
  for(const status of ['pending','running','done','needs_review','failed']){
    const job={id:'reply',data:{question_key:'q',status,title:'答复',related_ids:['t'],created_at:'2026-11-22'}};
    const items=briefItems(model,{primary:[],rest:[],latest:new Map([['q',job]])});
    assert.equal(items.length,1);assert.equal(items[0].id,'t');assert.equal(items[0].receipts[0].data.status,status);
  }
  const created={id:'reply',data:{question_key:'q',status:'done',related_ids:[]},targets:[{id:'t',kind:'action'}]};
  assert.equal(briefItems(model,{primary:[],rest:[]},[created])[0].receipts[0],created);
  task.data.status='done';const retained=briefItems(model,{primary:[],rest:[]},[created]);assert.equal(retained.length,1);assert.equal(retained[0].receipts.length,1);
});
test('chat notifications require both the expected frame and exact origin',()=>{
  const child={},frame={contentWindow:child},valid={origin:'http://localhost:8775',source:child,data:{lumosChat:'saved'}};
  assert.equal(trustedChatMessage(valid,frame,valid.origin),true);
  assert.equal(trustedChatMessage({...valid,origin:'http://evil.test'},frame,valid.origin),false);
  assert.equal(trustedChatMessage({...valid,source:{}},frame,valid.origin),false);
  assert.equal(trustedChatMessage({...valid,data:{lumosChat:'execute'}},frame,valid.origin),false);
});
test('each role leads to its working surface with no stacked secondary navigation',()=>{
  assert.equal(roleSpaces.librarian.home,'/knowledge');
  for(const role of Object.values(roleSpaces))assert.deepEqual(role.links,[]);
});

test('chat width stays usable at viewport limits and malformed preferences use defaults',()=>{
  assert.equal(chatDockWidth(700,1265),700);
  assert.equal(chatDockWidth(2000,1265),785);
  assert.equal(chatDockWidth(20,1265),360);
  assert.equal(chatDockWidth(700,390),390);
  assert.equal(chatDockWidth(700,801),360);
  for(const raw of ['{bad','null','[]','{"width":"900","open":"true"}'])assert.deepEqual(chatDockPreference(raw),{width:480,open:false});
});

function dockPage(storage=new Map(),role='aipm',workspace='lingguang'){
  class Element{
    constructor(){this.children=[];this.attrs={};this.classes=new Set();this.classList={add:c=>this.classes.add(c),remove:c=>this.classes.delete(c)};this.style={setProperty:(k,v)=>this.attrs[k]=v};this.events={};}
    append(...nodes){this.children.push(...nodes);}setAttribute(k,v){this.attrs[k]=v;}getAttribute(k){return k==='src'?this.src:this.attrs[k];}
    addEventListener(k,fn){this.events[k]=fn;}focus(){}setPointerCapture(id){this.pointer=id;}hasPointerCapture(id){return this.pointer===id;}releasePointerCapture(){this.pointer=null;}
  }
  const body=new Element(),events={},document={body,createElement:()=>new Element(),querySelector:()=>null,addEventListener(){}},window={innerWidth:1265,addEventListener:(k,fn)=>events[k]=fn};
  const world={document,window,location:new URL('http://localhost/?role='+role+'&workspace='+workspace),URL,roleSpaces,pageRole:()=>role,localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}};
  require('node:vm').runInNewContext(require('node:fs').readFileSync('web/workspace.js','utf8'),world);
  const [dock,open]=body.children,[handle,bar,frame]=dock.children,close=bar.children[1];
  return {body,dock,open,handle,close,frame,storage,viewport(width){window.innerWidth=width;events.resize();},key(key){handle.onkeydown({key,preventDefault(){}});}};
}

test('dragging and keyboard resizing persist per role and scope without replacing the conversation',()=>{
  const p=dockPage();assert.equal(p.dock.hidden,true);p.open.onclick();const src=p.frame.src;
  p.handle.onpointerdown({button:0,pointerId:1,clientX:785,preventDefault(){}});
  p.handle.onpointermove({pointerId:1,clientX:565});p.handle.onpointerup();
  assert.equal(p.body.attrs['--workspace-chat-width'],'700px');assert.equal(p.frame.src,src);
  const back=dockPage(p.storage);assert.equal(back.dock.hidden,false);assert.equal(back.body.attrs['--workspace-chat-width'],'700px');
  assert.equal(dockPage(p.storage,'lumos').dock.hidden,true);assert.equal(dockPage(p.storage,'aipm','lumos').dock.hidden,true);
  back.key('ArrowLeft');assert.equal(back.body.attrs['--workspace-chat-width'],'724px');
  back.close.onclick();const closed=dockPage(p.storage);assert.equal(closed.dock.hidden,true);assert.equal(closed.body.attrs['--workspace-chat-width'],'724px');
});

test('responsive clamps never overwrite the preferred desktop width and canceled drags clean up',()=>{
  const p=dockPage();p.open.onclick();p.key('End');assert.equal(p.body.attrs['--workspace-chat-width'],'785px');
  p.viewport(900);assert.equal(p.body.attrs['--workspace-chat-width'],'420px');
  p.viewport(390);assert.equal(p.body.attrs['--workspace-chat-width'],'390px');
  p.viewport(1265);assert.equal(p.body.attrs['--workspace-chat-width'],'785px');
  p.handle.onpointerdown({button:0,pointerId:2,clientX:320,preventDefault(){}});p.handle.onpointermove({pointerId:2,clientX:420});p.handle.onpointercancel();
  assert.equal(p.body.classes.has('chat-resizing'),false);assert.equal(dockPage(p.storage).body.attrs['--workspace-chat-width'],'685px');
});
