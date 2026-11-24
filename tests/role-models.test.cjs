const test=require('node:test'),assert=require('node:assert/strict');
const {selectedRoleModel,receiptModel}=require('../web/role-models.js');
const {modelPreferences}=require('../web/role-models.js');
function preferencesFixture(initial={},local=[]){
  const values=new Map(local),server={models:{...initial}},posts=[];
  const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const fetcher=async(url,options)=>{
    if(server.offline)throw Error('网络暂不可用');
    if(options){assert.equal(options.keepalive,true);const r=JSON.parse(options.body);posts.push(r);
      if(server.reject||Object.keys(r.models).some(k=>(server.models[k]??null)!==r.expected[k]&&server.models[k]!==r.models[k]))return {ok:false,json:async()=>({error:'设置已变化'})};
      Object.assign(server.models,r.models);
    }
    return {ok:true,json:async()=>({models:{...server.models},token:'test-token'})};
  };
  const api=modelPreferences(fetcher,storage,()=>{});return {api,server,posts,storage,fetcher};
}
test('server role choices override local cache and only missing choices are imported',async()=>{
  const p=preferencesFixture({lumos:'server-model'},[['lumos.chat.model.lumos','old-model'],['lumos.chat.model.aipm','']]);await p.api.ready;
  assert.equal(p.api.get('lumos'),'server-model');assert.equal(p.api.get('aipm'),'');
  assert.deepEqual(p.posts,[{models:{aipm:''},expected:{aipm:null}}]);
  await p.api.save('librarian','atlas-model');
  const other=modelPreferences(p.fetcher,{getItem:()=>null,setItem(){}},()=>{});await other.ready;
  assert.equal(other.get('librarian'),'atlas-model');assert.equal(p.server.models.lumos,'server-model');
});
test('failed model save shows server value, preserves other roles and allows a corrected retry',async()=>{
  const p=preferencesFixture({lumos:'one',aipm:'project'});await p.api.ready;
  p.server.models.lumos='changed-elsewhere';
  await assert.rejects(p.api.save('lumos','my-choice'),/设置已变化/);
  assert.equal(p.api.get('lumos'),'changed-elsewhere');assert.equal(p.api.busy,false);assert.ok(p.api.error);
  await p.api.save('lumos','my-choice');assert.equal(p.api.error,'');assert.equal(p.server.models.aipm,'project');
  await p.api.save('lumos','');assert.equal(p.api.get('lumos'),'');
});
test('queued model selections retain both roles and connection failure does not claim a save',async()=>{
  const p=preferencesFixture();await p.api.ready;
  await Promise.all([p.api.save('lumos','coordinator'),p.api.save('aipm','project')]);
  assert.deepEqual(p.server.models,{lumos:'coordinator',aipm:'project'});
  p.server.offline=true;await assert.rejects(p.api.save('lumos','unsaved'),/网络暂不可用/);
  assert.equal(p.api.get('lumos'),'coordinator');assert.ok(p.api.error);
  p.server.offline=false;await p.api.reload();assert.equal(p.api.error,'');
});
test('a refresh racing a selection cannot silently overwrite another page choice',async()=>{
  const p=preferencesFixture({lumos:'displayed'});let release,hold=false;
  const api=modelPreferences(async(...args)=>{const response=await p.fetcher(...args);if(hold&&!args[1]){hold=false;await new Promise(resolve=>release=resolve);}return response;},p.storage,()=>{});
  await api.ready;p.server.models.lumos='other-page';hold=true;
  const reload=api.reload();await new Promise(resolve=>setImmediate(resolve));
  const save=api.save('lumos','my-selection');release();await reload;
  await assert.rejects(save,/设置已变化/);assert.equal(p.server.models.lumos,'other-page');
});
test('unchanged polling does not rebuild model controls while the user is choosing',async()=>{
  const p=preferencesFixture({lumos:'selected'});let changes=0;
  const api=modelPreferences(p.fetcher,p.storage,()=>changes++);await api.ready;const initial=changes;
  await api.reload();await api.reload();assert.equal(changes,initial);
  p.server.models.lumos='new';await api.reload();assert.equal(changes,initial+1);
});
test('role models share the existing conversation preference and preserve an explicit default',()=>{
  const values=new Map([['lumos.chat.model','old-model'],['lumos.chat.model.aipm','project-model'],['lumos.chat.model.lumos','']]),storage={getItem:k=>values.get(k)??null};
  assert.equal(selectedRoleModel('aipm',storage),'project-model');assert.equal(selectedRoleModel('lumos',storage),'');assert.equal(selectedRoleModel('librarian',storage),'old-model');
  assert.equal(selectedRoleModel('lumos',{getItem(){throw Error();}}),'');
});
test('historical execution models are never inferred from the current preference',()=>{
  assert.equal(receiptModel({model:'selected',agent_steps:[{model:'recorded'},{model:'none'}]}),'recorded');
  assert.equal(receiptModel({agent_steps:[{model:'none'}]}),'未调用模型');
  assert.equal(receiptModel({agent_steps:[{model:'executor-default'}]}),'默认模型（具体型号未记录）');
  assert.equal(receiptModel({model:'pending-choice'}),'pending-choice');
});

test('saving an effort uses the reviewed model and effort, and historical labels stay unfilled',async()=>{
  const settings={models:{lumos:'gpt-6.2-astra',aipm:'gpt-6.2-sol',librarian:'gpt-6.2-sol',maintainer:'gpt-6.2-astra'},efforts:{lumos:'high'}};
  let body;
  const fetcher=async(url,options)=>{
    if(options){body=JSON.parse(options.body);Object.assign(settings.efforts,body.efforts);}
    return {ok:true,json:async()=>structuredClone(settings)};
  };
  const api=modelPreferences(fetcher,{getItem:()=>null,setItem(){}},()=>{});await api.ready;
  await api.save('lumos','gpt-6.2-astra','medium');
  assert.deepEqual(body,{models:{lumos:'gpt-6.2-astra'},expected:{lumos:'gpt-6.2-astra'},efforts:{lumos:'medium'},expected_efforts:{lumos:'high'}});
  assert.equal(api.effort('lumos'),'medium');
  assert.equal(receiptModel({agent_steps:[{role:'lumos',model:'gpt-6.2-astra',reasoning_effort:'medium'},{role:'librarian',model:'executor-default'}]}),
    'Lumos gpt-6.2-astra medium / Atlas 默认模型（具体型号未记录）');
});
