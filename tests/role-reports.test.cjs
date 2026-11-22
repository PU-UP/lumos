const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {reportItems,reportLabel}=require('../web/role-reports.js');
test('work receipts and Ops diagnoses retain different meanings and recipients',()=>{
  const data={lumos_reports:[{episode_id:'one'}],ops_reports:[{episode_id:'two'}],episodes:[{id:'old'}]};
  assert.equal(reportItems(data,'lumos')[0].episode_id,'one');assert.equal(reportItems(data,'maintainer')[0].episode_id,'two');
  assert.equal(reportItems(data,'lumos',true)[0].id,'old');
  assert.equal(reportItems({...data,issues:[{episode_id:'grouped'}]},'maintainer')[0].episode_id,'grouped');
  assert.equal(reportLabel({status:'rechecked'},'maintainer'),'复查未再发现此异常');
  assert.equal(reportLabel({status:'processing',outcome:'failed'},'lumos'),'处理受阻 · 已报 Ops');
  assert.equal(reportLabel({status:'received',decision:null},'lumos'),'已同步 Lumos');
  assert.equal(reportLabel({status:'received',decision:{phase:'decide'}},'lumos'),'Lumos 已决策 · 已保存');
  assert.equal(reportLabel({status:'received',decision:{phase:'external'}},'lumos'),'Lumos 外部协调 · 已保存');
  assert.equal(reportLabel({status:'diagnosed'},'maintainer'),'已给出诊断 · 未确认修复');
  assert.ok(!fs.readFileSync('web/role-reports.html','utf8').includes('<details'));
});
test('report page safely links exact original conversation and ignores a stale workspace response',async()=>{
  class Element{constructor(){this.children=[];this.value='';}append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}setAttribute(k,v){this[k]=v;}addEventListener(){}}
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const requests=[],location=new URL('http://127.0.0.1/agents?role=lumos'),world={URL,location,
    window:{history:{replaceState(_a,_b,u){location.href=String(u);}}},document:{getElementById:get,createElement:()=>new Element()},
    fetch:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))};
  vm.runInNewContext(fs.readFileSync('web/dialog.js','utf8'),world);vm.runInNewContext(fs.readFileSync('web/role-reports.js','utf8'),world);
  get('workspace').value='lumos';get('workspace').onchange();
  requests[1].resolve({ok:true,json:async()=>({token:'ok',lumos_reports:[{episode_id:'exact',title:'<script>literal</script>',chat_id:'chat-one',agent_role:'aipm',status:'received',at:'2026-11-21T00:00:00Z',summary:'原结果'}],episodes:[]})});
  await new Promise(r=>setImmediate(r));const card=get('report-list').children[0],links=card.children.at(-1).children;
  assert.equal(card.children[0].children[0].textContent,'<script>literal</script>');
  const target=new URL(links[0].href,location);assert.equal(target.searchParams.get('workspace'),'lumos');assert.equal(target.searchParams.get('id'),'chat-one');assert.equal(target.searchParams.get('role'),'aipm');
  requests[0].reject(new Error('old failure'));await new Promise(r=>setImmediate(r));assert.equal(get('reports-error').textContent,'');
});
