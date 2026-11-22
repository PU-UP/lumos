const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};}
  append(...nodes){for(const n of nodes){this.children.push(n);n.parent=this;}}
  setAttribute(k,v){this.attrs[k]=v;}addEventListener(){}showModal(){this.open=true;}close(){this.open=false;}
  closest(){return Object.hasOwn(this.attrs,'data-role-detail')?this:this.parent?.closest();}
}
test('secondary sources use one explicit dialog and nested versions remain readable without more folds',()=>{
  const world={window:{},document:{getElementById:()=>null,querySelector:()=>null,createElement:tag=>new Element(tag),body:{classList:{add(){}}}}};
  vm.runInNewContext(fs.readFileSync('web/dialog.js','utf8'),world);
  vm.runInNewContext(fs.readFileSync('web/role-ui.js','utf8'),world);
  const host=new Element('section'),body=world.window.LumosRoleUI.panel('固定来源',host);
  const [button,dialog]=host.children;assert.equal(button.attrs['aria-haspopup'],'dialog');button.onclick();assert.equal(dialog.open,true);
  const nested=world.window.LumosRoleUI.panel('<script>原文</script>',body);assert.equal(nested.tagName,'section');assert.equal(nested.children[0].textContent,'<script>原文</script>');
  assert.equal(body.children.filter(n=>n.tagName==='dialog').length,0);dialog.children[0].children[1].onclick();assert.equal(dialog.open,false);
});

const {readableChanges,detailWidth}=require('../web/role-ui.js');
test('readable history shows real field changes without internal revision metadata',()=>{
  const changes=readableChanges({before:{data:{owner:'王牧楠',follow_up:'2026-11-22',status:'todo'}},after:{data:{owner:'王牧楠',follow_up:'2026-11-23',status:'doing',revision:8,task_ids:['internal']}}});
  assert.deepEqual(changes,[{label:'下次跟进',before:'2026-11-22',after:'2026-11-23'},{label:'状态',before:'待处理',after:'进行中'}]);
  assert.equal(detailWidth(880,1280),880);assert.equal(detailWidth(4000,1280),1200);assert.equal(detailWidth(100,1280),360);assert.equal(detailWidth(880,390),390);
});
