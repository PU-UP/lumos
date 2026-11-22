'use strict';
// Reuse the existing conversation, including its draft and retry protections.
function trustedChatMessage(event,frame,origin){return event.origin===origin&&event.source===frame.contentWindow&&['saved','close'].includes(event.data?.lumosChat);}
if(typeof module!=='undefined')module.exports={trustedChatMessage};
if(typeof document!=='undefined'){
  const url=new URL(location.href),role=pageRole(url),info=roleSpaces[role];
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  if(url.pathname==='/chat'){
    const aside=document.querySelector('.chat-layout aside'),toggle=el('button','切换对话');toggle.type='button';toggle.setAttribute('aria-expanded','false');
    document.querySelector('.conversation-heading').append(toggle);aside.hidden=true;
    toggle.onclick=()=>{aside.hidden=!aside.hidden;toggle.setAttribute('aria-expanded',String(!aside.hidden));};
    const back=el('button','返回对话');back.type='button';back.onclick=()=>{aside.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();};aside.prepend(back);
    aside.addEventListener('click',event=>{if(event.target.closest('.chat-link, #new-chat')){aside.hidden=true;toggle.setAttribute('aria-expanded','false');}});
    if(url.searchParams.get('embedded')==='1'){
      document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]'))parent.postMessage({lumosChat:'close'},location.origin);});
      document.addEventListener('click',event=>{const a=event.target.closest('a');if(a&&new URL(a.href).pathname!=='/chat')a.target='_top';});
    }
  }else{
    const dock=el('aside'),bar=el('div'),heading=el('h2','与 '+info.name+' 对话'),close=el('button','收起对话'),frame=el('iframe'),open=el('button','和 '+info.name+' 聊'),updated=el('button','内容已更新 · 刷新');
    dock.id='workspace-chat';dock.hidden=true;dock.setAttribute('aria-label',heading.textContent);bar.className='workspace-chat-bar';
    frame.title=heading.textContent;open.className='workspace-chat-open primary';open.type=close.type=updated.type='button';open.setAttribute('aria-controls',dock.id);open.setAttribute('aria-expanded','false');
    updated.hidden=true;updated.className='workspace-update';bar.append(heading,close);dock.append(bar,frame);document.body.append(dock,open,updated);
    const syncOverlay=()=>{for(const child of document.body.children)if(child!==dock)child.inert=!dock.hidden&&window.innerWidth<=800;};
    window.addEventListener('resize',syncOverlay);
    const hide=()=>{dock.hidden=true;syncOverlay();document.body.classList.remove('chat-docked');open.setAttribute('aria-expanded','false');open.focus();};
    function show(address){
      if(!frame.getAttribute('src')){const target=new URL(address||'/chat',location.href);target.searchParams.set('role',role);target.searchParams.set('workspace',new URL(location.href).searchParams.get('workspace')||'lingguang');target.searchParams.set('embedded','1');frame.src=target.pathname+target.search;}
      dock.hidden=false;syncOverlay();document.body.classList.add('chat-docked');open.setAttribute('aria-expanded','true');close.focus();
    }
    open.onclick=()=>dock.hidden?show():hide();close.onclick=hide;
    dock.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});
    updated.onclick=()=>{const refresh=document.querySelector('#refresh, #refresh-notes, #refresh-reports');if(refresh)refresh.click();else location.reload();updated.hidden=true;};
    window.addEventListener('message',event=>{if(!trustedChatMessage(event,frame,location.origin))return;if(event.data.lumosChat==='close')hide();else updated.hidden=false;});
    // Ordinary chat links open beside the work; links carrying an exact episode keep their own context.
    document.addEventListener('click',event=>{const a=event.target.closest('a');if(!a||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;const target=new URL(a.href);if(target.origin===location.origin&&target.pathname==='/chat'&&!target.searchParams.has('episode')&&!target.searchParams.has('material')&&!target.searchParams.has('id')){event.preventDefault();show(a.href);}});
  }
}
