'use strict';
window.LumosRoleUI=(()=>{
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let serial=0;
  function section(title,parent){const box=el('section');box.className='role-facts';box.append(el('h3',title));parent.append(box);return box;}
  function panel(title,parent){
    if(parent.closest('[data-role-detail]'))return section(title,parent);
    const button=el('button',title),dialog=el('dialog'),heading=el('div'),label=el('h2',title),close=el('button','关闭'),body=el('div');
    button.type=close.type='button';button.className='role-detail-button';button.setAttribute('aria-haspopup','dialog');
    label.id='role-detail-'+(++serial);dialog.setAttribute('aria-labelledby',label.id);dialog.className='role-detail-dialog';heading.className='dialog-heading';body.setAttribute('data-role-detail','');
    heading.append(label,close);dialog.append(heading,body);parent.append(button,dialog);
    button.onclick=()=>dialog.showModal();close.onclick=()=>dialog.close();
    return body;
  }
  function replaceDetails(id,asPanel=false){
    const old=document.getElementById(id);if(!old)return;
    const summary=old.querySelector('summary'),box=el('section');
    for(const attr of old.attributes)if(attr.name!=='open')box.setAttribute(attr.name,attr.value);
    const children=[...old.children].filter(n=>n!==summary);old.replaceWith(box);
    if(asPanel){const body=panel(summary.textContent,box);body.append(...children);const dialog=box.querySelector('dialog');
      box.querySelector('button').onclick=()=>{box.open=true;box.dispatchEvent(new Event('toggle'));dialog.showModal();};dialog.addEventListener('close',()=>{box.open=false;});
    }else{const heading=el('h2');if(summary.id)heading.id=summary.id;heading.append(...summary.childNodes);box.append(heading,...children);}
  }
  document.body.classList.add('role-layout');
  for(const id of ['attention','independent','context-details'])replaceDetails(id);
  for(const id of ['intake-panel','task-review-result','note-history'])replaceDetails(id,true);
  const help=document.querySelector('.processing-help');if(help)help.remove();
  const dateHelp=document.querySelector('.date-help');if(dateHelp)dateHelp.textContent='下次关心是复核进展的时间；当前交付优先采用 Lumos 计划，原约定保留在详情中。';
  const attentionHelp=document.querySelector('.attention-description');if(attentionHelp)attentionHelp.textContent='当前需要你判断的问题在这里回答；未来安排可在“后续再跟进”中查看。';
  const scope=value=>window.dispatchEvent(new CustomEvent('lumos-scope',{detail:value}));
  return {section,panel,scope};
})();
