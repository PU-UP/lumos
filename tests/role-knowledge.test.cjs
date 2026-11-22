const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {materialState}=require('../web/role-knowledge.js');
const tick=()=>new Promise(r=>setImmediate(r));
class Element{
  constructor(){this.children=[];this.value='';this.textContent='';}
  append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;}
  showModal(){this.open=true;}close(){this.open=false;}
}
const descendants=n=>[n,...n.children.flatMap(descendants)];
async function page(){
  const els=new Map(),get=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);},posts=[];
  const world={document:{getElementById:get,createElement:()=>new Element()},location:{href:'http://localhost/knowledge?materials=1'},history:{replaceState(){}},URL,crypto,dismissOnBackdrop(){},
    fetch:async(path,opts)=>{let data;if(opts){posts.push(JSON.parse(opts.body));data={material:{data:{material:{extraction:'已读取文本'}}}};}
      else if(path.startsWith('/api/knowledge'))data={token:'t',contexts:[{id:'mapping',title:'定位'}]};
      else if(path.startsWith('/api/notes'))data={notes:[{id:'note-test'+path.includes('archived=true'),data:{title:path.includes('archived=true')?'归档笔记':'当前笔记',date:'2026-11-22',status:path.includes('archived=true')?'archived':'active'}}]};
      else if(path.startsWith('/api/material?'))data={material:{data:{title:'条件.md',text:'<script>unsafe()</script>',revision:1,material:{extraction:'已读取文本',sha256:'a'.repeat(64)}}},versions:[{revision:1,at:'2026-11-21'}],affected:[]};
      else data={token:'t',files:[{path:'条件.md',size:100,registrations:[]}]};
      return {ok:true,status:200,json:async()=>data};}};
  vm.createContext(world);vm.runInContext(fs.readFileSync('web/role-knowledge.js','utf8'),world);await tick();
  return {get,world,posts};
}
test('material states separate discovery, parsed text and saved originals',()=>{
  assert.match(materialState({registrations:[]}),/尚未登记/);
  assert.match(materialState({registrations:[{has_text:false}]}),/仅保存原件/);
  assert.match(materialState({registrations:[{has_text:true}]}),/正文可检索/);
});
test('material browsing never registers and an uncertain registration retries identical content',async()=>{
  const p=await page(),all=descendants(p.get('material-list'));
  assert.equal(p.get('search-panel').hidden,false);assert.equal(p.get('material-panel').hidden,false);
  assert.ok(descendants(p.get('library-notes')).some(n=>n.textContent==='当前笔记'));
  const link=all.find(n=>n.textContent==='交给 Atlas 查阅');assert.match(link.href,/material=/);assert.equal(p.posts.length,0);
  all.find(n=>n.textContent==='登记资料').onclick();assert.equal(p.get('context').value,'');
  p.get('context').value='mapping';const normal=p.world.fetch;let first;
  p.world.fetch=async(path,opts)=>{if(opts){first=JSON.parse(opts.body);throw new Error('lost response');}return normal(path,opts);};
  await p.get('register-form').onsubmit({preventDefault(){}});assert.equal(p.get('context').disabled,true);
  p.world.fetch=normal;await p.get('register-form').onsubmit({preventDefault(){}});
  assert.deepEqual(p.posts[0],first);assert.equal(p.get('context').disabled,false);
});
test('source and metadata remain inert text and layout has no folded details',()=>{
  const js=fs.readFileSync('web/role-knowledge.js','utf8');assert.ok(!js.includes('innerHTML'));
  assert.ok(!fs.readFileSync('web/role-knowledge.html','utf8').includes('<details'));
});

test('including archived notes keeps current notes in the unified library',async()=>{
  const p=await page();p.get('archived').checked=true;await p.get('archived').onchange();
  const titles=descendants(p.get('library-notes')).map(n=>n.textContent);
  assert.ok(titles.includes('当前笔记'));assert.ok(titles.includes('归档笔记'));assert.equal(p.posts.length,0);
});
