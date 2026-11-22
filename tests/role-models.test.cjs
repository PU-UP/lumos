const test=require('node:test'),assert=require('node:assert/strict');
const {selectedRoleModel,receiptModel}=require('../web/role-models.js');
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
