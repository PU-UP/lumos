const test=require('node:test'),assert=require('node:assert/strict');
const {briefItems}=require('../web/overview.js');
const {trustedChatMessage}=require('../web/workspace.js');
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
