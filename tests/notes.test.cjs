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
function saved(req){return {note:{id:req.id,kind:'note',data:{...req.changes,revision:req.expected_revision+1}}};}
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
 assert.equal(p.get('save-state').textContent,'已保存');assert.equal(Object.keys(p.world.localStorage).length,0);
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
