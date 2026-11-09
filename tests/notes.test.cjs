const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const tick = () => new Promise(r => setImmediate(r));
const response = (data, status=200) => ({ok:status===200,status,json:async()=>data});
class Element {
  constructor(){this.value='';this.children=[];this.events={};this.hidden=false;}
  append(...v){this.children.push(...v);}
  replaceChildren(...v){this.children=v;}
  get lastChild(){return this.children.at(-1);}
  addEventListener(k,fn){this.events[k]=fn;}
  setAttribute(k,v){this[k]=v;}
  focus(){}
}
function storage(){const data={};return new Proxy(data,{get:(t,k)=>k==='getItem'?(key)=>t[key]??null:k==='setItem'?(key,v)=>t[key]=v:k==='removeItem'?(key)=>delete t[key]:t[k]});}
async function page(){
 const els=new Map(), get=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
 get('note-workspace').value='lingguang';get('note-status').value='false';
 const listing={notes:[],store_id:'fixture',writable:true,token:'test',today:'2026-10-26'};
 const world={document:{getElementById:get,createElement:()=>new Element(),createTextNode:text=>({textContent:text})},
  window:{addEventListener(){}},history:{replaceState(){}},location:{search:''},URLSearchParams,crypto,
  sessionStorage:storage(),localStorage:storage(),setTimeout:()=>1,clearTimeout(){},fetch:async()=>response(listing)};
 vm.createContext(world);vm.runInContext(fs.readFileSync('web/notes.js','utf8'),world);await tick();
 await get('new-note').onclick();
 return {world,get,listing};
}
function edit(p,text){p.get('note-body').value=text;p.get('note-body').events.input();}
function saved(req){return {note:{id:req.id,kind:'note',data:{...req.changes,recording:req.operation==='finish'?'finished':req.operation==='edit'?'editing':req.recording || 'editing',revision:req.expected_revision+1}}};}

test('archived note edits, autosaves and finishes without restoring or losing its reason',async()=>{
 const p=await page();let latest={id:'note-archived',data:{title:'归档笔记',body:'错名',date:'2026-11-09',workspace:'lingguang',status:'archived',archive_reason:'已整理',recording:'finished',revision:3}};
 const requests=[];
 p.world.fetch=async(url,opt)=>{
  if(!opt)return response(url.startsWith('/api/note?')?{note:latest,history:[],tasks:[]}:p.listing);
  const req=JSON.parse(opt.body);requests.push(req);latest=saved(req).note;return response({note:latest});
 };
 await p.world.openNote(latest.id);
 assert.equal(p.get('preview-note').disabled,false);
 await p.get('preview-note').onclick();edit(p,'正名');await p.world.save();
 assert.match(p.get('save-state').textContent,/已归档.*编辑中/);
 await p.get('preview-note').onclick();
 assert.deepEqual(requests.map(r=>r.operation),['edit','save','finish']);
 assert.ok(requests.every(r=>r.changes.status==='archived' && r.changes.archive_reason==='已整理'));
 assert.equal(latest.data.body,'正名');assert.equal(p.get('note-body').disabled,true);
 assert.equal(p.get('save-state').textContent,'已归档 · 阅读模式');
});

test('confirmed validation rejection retries corrected content, including after draft recovery',async()=>{
 const p=await page();let latest={id:'note-validation',data:{title:'原题',body:'正文',date:'2026-11-09',workspace:'lingguang',status:'archived',archive_reason:'已整理',recording:'finished',revision:3}};
 const requests=[];
 p.world.fetch=async(url,opt)=>{
  if(!opt)return response(url.startsWith('/api/note?')?{note:latest,history:[],tasks:[]}:p.listing);
  const req=JSON.parse(opt.body);requests.push(req);
  if(req.changes.title.length>300)return response({error:'Invalid note title'},409);
  latest=saved(req).note;return response({note:latest});
 };
 await p.world.openNote(latest.id);
 p.get('note-title').value='x'.repeat(301);p.get('note-title').events.input();
 assert.equal(await p.world.save('edit'),false);
 p.world.showDrafts();
 // Restore the saved rejection marker in a fresh page, as after a reload.
 const q=await page();Object.assign(q.world.localStorage,p.world.localStorage);q.world.fetch=p.world.fetch;
 q.world.showDrafts();await q.get('drafts').children[0].onclick();
 q.get('note-title').value='更正';q.get('note-title').events.input();
 assert.equal(await q.world.save(),true);
 assert.notEqual(requests[0].request_id,requests[1].request_id);
 assert.equal(requests[1].operation,'edit');assert.equal(requests[1].changes.title,'更正');
 assert.equal(latest.data.status,'archived');
});

test('stale recovered draft merges into archived latest version and can finish',async()=>{
 const p=await page();
 const draft={current:{id:'note-stale',data:{revision:2,title:'笔记',body:'原文',date:'2026-11-09',workspace:'lingguang',status:'active',archive_reason:'',recording:'finished'}},values:{title:'笔记',body:'改正姓名',date:'2026-11-09'},pending:null};
 p.world.localStorage.setItem('lumos-note:fixture:old:note-stale',JSON.stringify(draft));
 p.world.showDrafts();await p.get('drafts').children[0].onclick();
 let latest={id:'note-stale',data:{...draft.current.data,revision:3,status:'archived',archive_reason:'已整理'}};
 p.world.fetch=async(url,opt)=>{
  if(!opt)return response(url.startsWith('/api/note?')?{note:latest,history:[],tasks:[]}:p.listing);
  const req=JSON.parse(opt.body);
  if(req.expected_revision!==latest.data.revision)return response({error:'conflict'},409);
  latest=saved(req).note;return response({note:latest});
 };
 assert.equal(await p.world.save(),false);assert.equal(p.get('conflict').hidden,false);
 await p.get('merge-note').onclick();await p.get('preview-note').onclick();
 assert.equal(latest.data.body,'改正姓名');assert.equal(latest.data.status,'archived');
 assert.equal(latest.data.archive_reason,'已整理');assert.equal(latest.data.recording,'finished');
 assert.equal(Object.keys(p.world.localStorage).length,0);
});

test('new note can correct a rejected request before its first successful save',async()=>{
 const p=await page();const requests=[];
 p.world.fetch=async(url,opt)=>{
  if(!opt)return url.startsWith('/api/note?')?response({error:'Note not found'},409):response(p.listing);
  const req=JSON.parse(opt.body);requests.push(req);
  if(req.changes.title.length>300)return response({error:'Invalid note title'},409);
  return response(saved(req));
 };
 p.get('note-title').value='x'.repeat(301);edit(p,'保留正文');
 assert.equal(await p.world.save(),false);
 p.get('note-title').value='正确标题';p.get('note-title').events.input();
 assert.equal(await p.world.save(),true);
 assert.notEqual(requests[0].request_id,requests[1].request_id);
 assert.equal(requests[1].changes.body,'保留正文');
});
test('in-flight input is saved separately without loss or duplicate concurrent writes',async()=>{
 const p=await page();edit(p,'first');let release;const requests=[];
 p.world.fetch=async(url,options)=>{
  if(!options)return response(p.listing);
  const req=JSON.parse(options.body);requests.push(req);
  if(requests.length===1)return new Promise(r=>release=()=>r(response(saved(req))));
  return response(saved(req));
 };
 const saving=p.world.save();await tick();edit(p,'first and second');release();assert.equal(await saving,true);
 assert.equal(requests.length,2);assert.equal(requests[1].changes.body,'first and second');
 assert.equal(requests[1].expected_revision,1);assert.equal(p.get('note-body').value,'first and second');
 assert.equal(p.get('save-state').textContent,'记录中 · 已自动保存');assert.equal(Object.keys(p.world.localStorage).length,0);
});
test('unknown network result retries identical request before saving newer input',async()=>{
 const p=await page();edit(p,'original');let first,failed=false;const requests=[];
 p.world.fetch=async(url,opt)=>{
  if(!opt)return response(p.listing);
  const req=JSON.parse(opt.body);requests.push(req);
  if(!failed){failed=true;first=req;throw new Error('network unavailable');}
  return response(saved(req));
 };
 assert.equal(await p.world.save(),false);edit(p,'newer');assert.equal(await p.world.save(),true);
 assert.deepEqual(requests[1],first);assert.equal(requests[2].changes.body,'newer');
});
test('conflict keeps local text and exposes remote version until explicit merge',async()=>{
 const p=await page();edit(p,'local');let written;
 p.world.fetch=async(url,opt)=>{
  if(opt)return response({error:'conflict'},409);
  return response({note:{id:'note-fixture',data:{title:'remote',body:'server text',date:'2026-10-26',revision:2,status:'active',workspace:'lingguang',archive_reason:''}}});
 };
 assert.equal(await p.world.save(),false);assert.equal(p.get('note-body').value,'local');
 assert.equal(p.get('conflict').hidden,false);assert.match(p.get('remote-note').textContent,/server text/);
 assert.equal(p.get('save-note').disabled,true);assert.equal(Object.keys(p.world.localStorage).length,1);
 p.world.fetch=async(url,opt)=>{if(!opt)return response(p.listing);written=JSON.parse(opt.body);return response(saved(written));};
 edit(p,'local + server text');await p.get('merge-note').onclick();
 assert.equal(written.expected_revision,2);assert.equal(written.changes.body,'local + server text');
});
test('safe reading renders raw HTML as text and allows only http links',async()=>{
 const p=await page(),target=new Element();
 p.world.renderMarkdown('# 标题\n- 列表\n<script>alert(1)</script>\n[x](javascript:alert(1))\n[ok](https://example.com)',target);
 const flatten=n=>[n,...(n.children||[]).flatMap(flatten)],all=flatten(target);
 assert.ok(all.some(n=>n.textContent?.includes('<script>')));
 assert.equal(all.filter(n=>n.href).length,1);assert.equal(all.find(n=>n.href).href,'https://example.com');
});
test('archive and restore use explicit inline controls and preserve body',async()=>{
 const p=await page();edit(p,'keep original');let req;
 p.world.fetch=async(url,opt)=>{if(!opt)return response(p.listing);req=JSON.parse(opt.body);return response(saved(req));};
 await p.get('archive-note').onclick();assert.equal(p.get('archive-panel').hidden,false);
 p.get('archive-reason').value='reviewed';await p.get('confirm-archive').onclick();
 assert.equal(req.changes.status,'archived');assert.equal(req.changes.body,'keep original');
 await p.get('archive-note').onclick();assert.equal(req.changes.status,'active');
});

test('recovered draft waits for explicit save and then clears its recovery copy',async()=>{
 const p=await page();
 const draft={current:{id:'note-recovered',data:{revision:0,title:'',body:'',date:'2026-10-26',workspace:'lingguang',status:'active',archive_reason:''}},
  values:{title:'recovered',body:'unsaved content',date:'2026-10-26'},pending:null};
 p.world.localStorage.setItem('lumos-note:fixture:old-tab:note-recovered',JSON.stringify(draft));
 p.world.showDrafts();await p.get('drafts').children[0].onclick();
 assert.equal(p.get('note-body').value,'unsaved content');
 let writes=0;p.world.fetch=async(url,opt)=>{if(!opt)return response(p.listing);writes++;return response(saved(JSON.parse(opt.body)));};
 assert.equal(writes,0);assert.equal(await p.world.save(),true);assert.equal(writes,1);
 assert.equal(Object.keys(p.world.localStorage).length,0);
});

test('finish saves once as a checkpoint, reopens read-only, and edit explicitly unlocks',async()=>{
 const p=await page();edit(p,'完成正文');const requests=[];let latest;
 p.world.fetch=async(url,opt)=>{
  if(!opt)return response(url.startsWith('/api/note?')?{note:latest,history:[],tasks:[]}:p.listing);
  const req=JSON.parse(opt.body);requests.push(req);latest=saved(req).note;return response({note:latest});
 };
 await p.get('preview-note').onclick();
 assert.deepEqual(requests.map(r=>r.operation),['save','finish']);
 assert.equal(p.get('note-body').disabled,true);
 assert.equal(p.get('note-preview').hidden,false);
 await p.world.openNote(latest.id);
 assert.equal(p.get('note-body').disabled,true);
 assert.equal(p.get('preview-note').textContent,'编辑');
 await p.get('preview-note').onclick();
 assert.equal(requests.at(-1).operation,'edit');
 assert.equal(p.get('note-body').disabled,false);
 assert.equal(p.get('note-preview').hidden,true);
});
test('failed finish preserves text and does not enter reading mode',async()=>{
 const p=await page();edit(p,'保留我');
 p.world.fetch=async(url,opt)=>{
  if(!opt)return response(p.listing);
  const req=JSON.parse(opt.body);
  if(req.operation==='finish')throw new Error('offline');
  return response(saved(req));
 };
 await p.get('preview-note').onclick();
 assert.equal(p.get('note-body').value,'保留我');
 assert.equal(p.get('note-body').disabled,false);
 assert.equal(p.get('note-preview').hidden,true);
});

test('note list shows Shanghai modification date and time, archive button stays concise',async()=>{
 const p=await page();
 p.listing.notes=[{id:'fixture-note',data:{title:'笔记',date:'2026-10-27',updated_at:'2026-10-30T03:14:00Z',recording:'finished',status:'active'}}];
 await p.world.refreshList();
 const label=p.get('note-list').children[1].children[0].textContent;
 assert.match(label,/2026\/10\/30/);assert.match(label,/11:14/);
 assert.equal(p.get('archive-note').textContent,'归档');
});

test('retrying finish or edit keeps the original intent after a lost response',async()=>{
 for(const operation of ['finish','edit']) for(const retryWithSave of [false,true]) {
  const p=await page();edit(p,'正文');let fail=false;const requests=[];
  p.world.fetch=async(url,opt)=>{
   if(!opt)return response(p.listing);
   const req=JSON.parse(opt.body);requests.push(req);
   if(fail && req.operation===operation){fail=false;throw new Error('lost response');}
   return response(saved(req));
  };
  if(operation==='edit')await p.get('preview-note').onclick();
  fail=true;await p.get('preview-note').onclick();
  const failed=requests.at(-1);
  if(retryWithSave) await p.get('save-note').onclick();
  else await p.get('preview-note').onclick();
  assert.deepEqual(requests.at(-1),failed);
  assert.equal(p.get('note-body').disabled,operation==='finish');
  assert.equal(p.get('note-preview').hidden,operation!=='finish');
 }
});
