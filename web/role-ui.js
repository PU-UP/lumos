'use strict';
function readableChanges(history){
  const names={text:'任务名称',title:'事项名称',summary:'当前结论',progress:'进展',goal:'目标',phase:'阶段',risk:'风险',next_step:'下一步',owner:'负责人',due:'原约定交付',planned_due:'当前计划交付',follow_up:'下次跟进',review_on:'下次复核',status:'状态',condition:'完成条件',planning_reason:'排期依据'};
  const labels={todo:'待处理',doing:'进行中',blocked:'受阻',done:'已完成',cancelled:'已取消',long_term:'长期'};
  const before=history.before?.data||{},after=history.after?.data||{};
  return Object.entries(names).filter(([k])=>(before[k]||'')!==(after[k]||'')).map(([key,label])=>({label,before:labels[before[key]]||before[key]||'未记录',after:labels[after[key]]||after[key]||'未设置'}));
}
function detailWidth(value,viewport){return viewport<=700?viewport:Math.max(360,Math.min(value,viewport-80));}
if(typeof module!=='undefined')module.exports={readableChanges,detailWidth};
if(typeof window!=='undefined')window.LumosRoleUI=(()=>{
  const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let serial=0;
  function section(title,parent){const box=el('section');box.className='role-facts';box.append(el('h3',title));parent.append(box);return box;}
  function renderDocument(content,parent){
    let paragraph=[],list=null;
    const flush=()=>{if(paragraph.length)parent.append(el('p',paragraph.join('\n')));paragraph=[];};
    for(const line of content.split(/\r?\n/)){
      const heading=line.match(/^#{1,6}\s+(.+)$/),item=line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
      if(heading||item||!line.trim())flush();if(!item)list=null;
      if(heading)parent.append(el('h4',heading[1]));
      else if(item){if(!list){list=el('ul');parent.append(list);}list.append(el('li',item[1]));}
      else if(line.trim())paragraph.push(line);
    }
    flush();
  }
  function resizable(dialog){
    const handle=el('div'),key='lumos.detail.width.v1';let width=720,drag=null;
    try{const saved=Number(localStorage.getItem(key));if(Number.isFinite(saved)&&saved>=360)width=saved;}catch{}
    handle.className='detail-resize';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-label','调整详情宽度');handle.setAttribute('aria-orientation','vertical');handle.title='拖动调整宽度，或使用左右方向键';dialog.prepend(handle);
    const layout=()=>{const actual=detailWidth(width,window.innerWidth);dialog.style.width=actual+'px';handle.setAttribute('aria-valuenow',String(actual));handle.setAttribute('aria-valuemin',String(Math.min(360,actual)));handle.setAttribute('aria-valuemax',String(detailWidth(Number.MAX_VALUE,window.innerWidth)));};
    const save=()=>{try{localStorage.setItem(key,String(width));}catch{handle.title='当前宽度仍有效；浏览器未允许保存布局。';}};
    const end=()=>{if(!drag)return;const id=drag.id;drag=null;dialog.classList.remove('detail-resizing');if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);save();};
    handle.onpointerdown=e=>{if(e.button!==0||window.innerWidth<=700)return;e.preventDefault();handle.focus();drag={id:e.pointerId,x:e.clientX,width:detailWidth(width,window.innerWidth)};handle.setPointerCapture(e.pointerId);dialog.classList.add('detail-resizing');};
    handle.onpointermove=e=>{if(drag&&e.pointerId===drag.id){width=detailWidth(drag.width+drag.x-e.clientX,window.innerWidth);layout();}};
    handle.onpointerup=handle.onpointercancel=handle.onlostpointercapture=end;
    handle.onkeydown=e=>{const current=detailWidth(width,window.innerWidth),next={ArrowLeft:current+24,ArrowRight:current-24,Home:360,End:window.innerWidth-80}[e.key];if(next===undefined||window.innerWidth<=700)return;e.preventDefault();width=detailWidth(next,window.innerWidth);layout();save();};
    dialog.addEventListener('close',end);window.addEventListener('resize',()=>{end();layout();});layout();
  }
  function history(items,parent,openChange){
    if(!items.length)parent.append(el('p','尚无修改记录。'));
    for(const item of items){const row=section(new Date(item.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' · '+(item.before?'更新记录':'建立记录'),parent),changes=readableChanges(item);
      if(!changes.length)row.append(el('p','本次更新了关联资料或复核信息。'));
      if(openChange&&changes.length){row.append(el('p',(item.before?'更新了：':'记录了：')+changes.map(c=>c.label).join('、')));const button=el('button','查看这次变化');button.onclick=()=>openChange(item);row.append(button);}
      else for(const c of changes){row.append(el('h4',c.label));if(item.before)row.append(el('p','此前：'+c.before));row.append(el('p','现在：'+c.after));}
      const source=item.after?.data?.last_source||item.after?.data?.source;
      if(changes.length&&source?.reason)row.append(el('p','调整依据：'+source.reason));
    }
  }
  function panel(title,parent){
    if(parent.closest('[data-role-detail]'))return section(title,parent);
    const button=el('button',title),dialog=el('dialog'),heading=el('div'),label=el('h2',title),close=el('button','关闭'),body=el('div');
    button.type=close.type='button';button.className='role-detail-button';button.setAttribute('aria-haspopup','dialog');
    label.id='role-detail-'+(++serial);dialog.setAttribute('aria-labelledby',label.id);dialog.className='role-detail-dialog';heading.className='dialog-heading';body.setAttribute('data-role-detail','');
    heading.append(label,close);dialog.append(heading,body);parent.append(button,dialog);
    button.onclick=()=>{dismissOnBackdrop(dialog);dialog.showModal();};close.onclick=()=>dialog.close();
    return body;
  }
  function replaceDetails(id,asPanel=false){
    const old=document.getElementById(id);if(!old)return;
    const summary=old.querySelector('summary'),box=el('section');
    if(id==='intake-panel')summary.textContent='答复记录';
    for(const attr of old.attributes)if(attr.name!=='open')box.setAttribute(attr.name,attr.value);
    const children=[...old.children].filter(n=>n!==summary);old.replaceWith(box);
    if(asPanel){const body=panel(summary.textContent,box);body.append(...children);const dialog=box.querySelector('dialog');
      box.querySelector('button').onclick=()=>{box.open=true;box.dispatchEvent(new Event('toggle'));dismissOnBackdrop(dialog);dialog.showModal();};dialog.addEventListener('close',()=>{box.open=false;});
    }else{const heading=el('h2');if(summary.id)heading.id=summary.id;heading.append(...summary.childNodes);box.append(heading,...children);}
  }
  document.body.classList.add('role-layout');
  for(const id of ['attention','independent','context-details'])replaceDetails(id);
  for(const id of ['intake-panel','task-review-result','note-history'])replaceDetails(id,true);
  const help=document.querySelector('.processing-help');if(help)help.remove();
  const dateHelp=document.querySelector('.date-help');if(dateHelp)dateHelp.textContent='下次关心是复核进展的时间；当前交付优先采用 Lumos 计划，原约定保留在详情中。';
  const attentionHelp=document.querySelector('.attention-description');if(attentionHelp)attentionHelp.textContent='当前需要你判断的问题在这里回答；未来安排可在“后续再跟进”中查看。';
  const toolbar=document.querySelector('.task-toolbar');
  if(toolbar){
    const host=el('div');host.className='workspace-filters-button';toolbar.before(host);
    const filters=panel('筛选与视图',host);
    host.querySelector('button').id='workspace-filters-toggle';
    for(const selector of ['.workspace-filters','.task-toolbar','#follow-up-window']){const item=document.querySelector(selector);if(item)filters.append(item);}
    document.querySelector('.intro').append(host);
    const links=el('div');links.className='workspace-view-links';
    for(const [label,path] of [['人员','/people'],['阶段交付','/?view=delivery']]){const a=el('a',label);a.href=path+(path.includes('?')?'&':'?')+'role=aipm&workspace='+document.getElementById('workspace').value;links.append(a);}filters.append(links);
  }
  const scope=value=>window.dispatchEvent(new CustomEvent('lumos-scope',{detail:value}));
  return {section,panel,scope,resizable,history,renderDocument};
})();
