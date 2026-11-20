const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('navigation preserves workspace and destination parameters across sections',()=>{
  const storage=new Map([['lumos.workspace','lumos']]),events={},picker={value:'lingguang',addEventListener:(name,fn)=>events[name]=fn};
  const label={classList:{add(){}}};picker.closest=()=>label;
  const links=['/','/notes?id=note-one','/?view=delivery','/chat'].map(href=>({href,getAttribute(){return this.href;}}));
  const header={children:[{},{}],insertBefore(){},querySelector:()=>null,append(link){links.push(link);}};
  const location=new URL('http://127.0.0.1:8765/notes?id=note-one');
  const world={URL,location,history:{replaceState:(_a,_b,url)=>location.href=String(url)},localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    document:{querySelector:q=>q==='header'?header:picker,querySelectorAll:()=>links,createElement:()=>({setAttribute(){},getAttribute(){return this.href;}})},window:{addEventListener(){}}};
  vm.runInNewContext(fs.readFileSync('web/navigation.js','utf8'),world);
  assert.equal(picker.value,'lumos');assert.equal(location.searchParams.get('id'),'note-one');
  assert.ok(links.every(a=>new URL(a.href,location).searchParams.get('workspace')==='lumos'));
  assert.equal(new URL(links[2].href,location).searchParams.get('view'),'delivery');
  picker.value='lingguang';events.change();assert.equal(storage.get('lumos.workspace'),'lingguang');
  assert.ok(links.every(a=>new URL(a.href,location).searchParams.get('workspace')==='lingguang'));
});
test('retrieval groups files before source fragments and runtime summaries exclude obsolete outcomes',()=>{
  const {knowledgeGroups}=require('../web/knowledge.js'),{findingGroups}=require('../web/agents.js');
  const groups=knowledgeGroups([{kind:'evidence',id:'source'},{kind:'note',id:'note'},{kind:'evidence',id:'file',is_material:true}]);
  assert.deepEqual(groups.map(g=>g.items[0].id),['file','note','source']);
  assert.deepEqual(findingGroups([{code:'failed'},{code:'obsolete'},{code:'failed'},{code:'expired'}]).map(g=>g.items.length),[2,1]);
});

test('runtime history links clear on workspace change and stale failures cannot replace current results',async()=>{
  class Element{
    constructor(){this.children=[];this.options=[{}];this.value='';}
    append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}scrollIntoView(){}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const requests=[],location=new URL('http://127.0.0.1/agents?episode=old'),world={URL,location,
    document:{getElementById:get,createElement:()=>new Element()},history:{replaceState:(_a,_b,url)=>location.href=String(url)},
    fetch:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))};
  vm.runInNewContext(fs.readFileSync('web/agents.js','utf8'),world);
  get('workspace').value='lumos';get('workspace').onchange();assert.equal(location.searchParams.has('episode'),false);
  requests[1].resolve({ok:true,json:async()=>({roles:{},episodes:[],findings:[],token:'test',history_count:0})});
  await new Promise(r=>setImmediate(r));assert.equal(get('runtime-title').textContent,'当前没有需要接续的处理异常');
  requests[0].reject(new Error('old request failed'));await new Promise(r=>setImmediate(r));
  assert.equal(get('runtime-title').textContent,'当前没有需要接续的处理异常');assert.equal(get('inspect').disabled,false);
});
