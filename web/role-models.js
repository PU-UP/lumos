'use strict';
// One browser preference for each role, shared by the work page and its chat.
const roleModelKey=role=>'lumos.chat.model.'+role;
function selectedRoleModel(role,storage=localStorage){try{return storage.getItem(roleModelKey(role))??storage.getItem('lumos.chat.model')??'';}catch{return '';}}
function receiptModel(data){
  const recorded=[...new Set((data.agent_steps||[]).map(s=>s.model).filter(m=>m&&m!=='none'))];
  if(recorded.length)return recorded.map(m=>m==='executor-default'?'默认模型（具体型号未记录）':m).join(' / ');
  if(data.agent_steps?.length)return '未调用模型';
  return data.model||'默认模型（具体型号未记录）';
}
if(typeof module!=='undefined')module.exports={selectedRoleModel,receiptModel};
if(typeof window!=='undefined')window.LumosModels={get:selectedRoleModel,receipt:receiptModel};
