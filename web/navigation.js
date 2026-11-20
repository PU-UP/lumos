'use strict';
// Keep the current workspace when moving between the three everyday entry points.
(() => {
  const picker=document.querySelector('#workspace, #note-workspace, #chat-workspace');
  const header=document.querySelector('header');
  if(!picker||!header)return;
  const url=new URL(location.href),valid=value=>['lingguang','lumos'].includes(value);
  let saved='';try{saved=localStorage.getItem('lumos.workspace')||'';}catch{}
  const selected=url.searchParams.get('workspace');
  picker.value=valid(selected)?selected:valid(saved)?saved:'lingguang';
  const label=picker.closest('label');label.classList.add('global-workspace');
  header.insertBefore(label,header.children[1]||null);
  const divider=header.querySelector('.divider');
  if(divider){divider.nextElementSibling?.remove();divider.remove();}
  const status=document.createElement('a');status.href='/agents';status.textContent='运行情况';status.className='runtime-link';
  if(url.pathname==='/agents')status.setAttribute('aria-current','page');
  header.append(status);
  function sync(){
    const space=picker.value;
    try{localStorage.setItem('lumos.workspace',space);}catch{}
    const current=new URL(location.href);current.searchParams.set('workspace',space);history.replaceState(null,'',current);
    for(const link of document.querySelectorAll('.view-nav a, .section-links a, .mainline-views a, .runtime-link, .record-link')){
      const target=new URL(link.getAttribute('href'),location.href);target.searchParams.set('workspace',space);
      link.href=target.pathname+target.search;
    }
  }
  sync();picker.addEventListener('change',sync);window.addEventListener('DOMContentLoaded',sync);
})();
