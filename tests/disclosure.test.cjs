const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function page(storage=new Map(),blocked=false){
  const events={};
  const world={window:{addEventListener:(name,fn)=>events[name]=fn},localStorage:{getItem:k=>{if(blocked)throw Error();return storage.get(k)||null;},setItem:(k,v)=>{if(blocked)throw Error();storage.set(k,v);}}};
  vm.createContext(world);vm.runInContext(fs.readFileSync('web/disclosure.js','utf8'),world);
  return {bind:world.window.LumosDisclosure.remember,events};
}
const node=()=>({open:false,events:[],addEventListener(_name,fn){this.events.push(fn);},toggle(){this.events.forEach(fn=>fn());}});
test('reload retains the latest live state even before toggle dispatch and ignores stale node events',()=>{
  const storage=new Map(),first=page(storage),old=node(),replacement=node();
  first.bind(old,'space:questions');old.open=true;
  first.bind(replacement,'space:questions');assert.equal(replacement.open,true);
  old.open=false;old.toggle();first.events.pagehide();
  const fresh=node();page(storage).bind(fresh,'space:questions');assert.equal(fresh.open,true);
  replacement.open=false;replacement.toggle();
  const closed=node();page(storage).bind(closed,'space:questions',true);assert.equal(closed.open,false);
});
test('storage corruption or denial preserves working disclosure controls and in-page state',()=>{
  for(const blocked of [false,true]){
    const p=page(new Map([['lumos.disclosure.v1.key','invalid']]),blocked),first=node();
    p.bind(first,'key',true);assert.equal(first.open,true);first.open=false;first.toggle();
    const next=node();p.bind(next,'key',true);assert.equal(next.open,false);
    assert.doesNotThrow(()=>p.events.pagehide());
  }
});
