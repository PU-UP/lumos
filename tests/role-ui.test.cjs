const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};}
  append(...nodes){for(const n of nodes){this.children.push(n);n.parent=this;}}
  setAttribute(k,v){this.attrs[k]=v;}addEventListener(){}showModal(){this.open=true;}close(){this.open=false;}
  closest(){return Object.hasOwn(this.attrs,'data-role-detail')?this:this.parent?.closest();}
}
test('secondary sources use one explicit dialog and nested versions remain readable without more folds',()=>{
  const world={window:{},document:{getElementById:()=>null,querySelector:()=>null,createElement:tag=>new Element(tag),body:{classList:{add(){}}}}};
  vm.runInNewContext(fs.readFileSync('web/role-ui.js','utf8'),world);
  const host=new Element('section'),body=world.window.LumosRoleUI.panel('固定来源',host);
  const [button,dialog]=host.children;assert.equal(button.attrs['aria-haspopup'],'dialog');button.onclick();assert.equal(dialog.open,true);
  const nested=world.window.LumosRoleUI.panel('<script>原文</script>',body);assert.equal(nested.tagName,'section');assert.equal(nested.children[0].textContent,'<script>原文</script>');
  assert.equal(body.children.filter(n=>n.tagName==='dialog').length,0);dialog.children[0].children[1].onclick();assert.equal(dialog.open,false);
});
