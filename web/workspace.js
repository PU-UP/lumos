'use strict';
// Reuse the existing conversation, including its draft and retry protections.
function trustedChatMessage(event,frame,origin){return event.origin===origin&&event.source===frame.contentWindow&&['saved','close','read'].includes(event.data?.lumosChat);}
function chatDockWidth(preferred,viewport){return viewport<=800?viewport:Math.max(360,Math.min(preferred,viewport-480));}
function chatDockPreference(raw){try{const value=JSON.parse(raw);return {width:Number.isFinite(value?.width)&&value.width>=360?value.width:480,open:value?.open===true};}catch{return {width:480,open:false};}}
if(typeof module!=='undefined')module.exports={trustedChatMessage,chatDockWidth,chatDockPreference};
if(typeof document!=='undefined'){
  const url=new URL(location.href),role=pageRole(url),info=roleSpaces[role];
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  if(url.pathname==='/chat'){
    const aside=document.querySelector('.chat-layout aside'),toggle=document.getElementById('switch-chat');toggle.type='button';toggle.setAttribute('aria-expanded','false');
    document.getElementById('messages').before(aside);aside.hidden=true;
    toggle.onclick=()=>{aside.hidden=!aside.hidden;toggle.setAttribute('aria-expanded',String(!aside.hidden));};
    document.getElementById('new-chat').addEventListener('click',()=>{aside.hidden=true;toggle.setAttribute('aria-expanded','false');});
    aside.addEventListener('click',event=>{if(event.target.closest('.chat-link, #new-chat')){aside.hidden=true;toggle.setAttribute('aria-expanded','false');}});
    if(url.searchParams.get('embedded')==='1'){
      document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){if(!aside.hidden){aside.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.focus();}else parent.postMessage({lumosChat:'close'},location.origin);}});
      document.addEventListener('click',event=>{const a=event.target.closest('a');if(a&&new URL(a.href).pathname!=='/chat')a.target='_top';});
    }
  }else{
    const dock=el('aside'),bar=el('div'),heading=el('h2','与 '+info.name+' 对话'),close=el('button','×'),frame=el('iframe'),open=el('button','和 '+info.name+' 聊'),updated=el('button','内容已更新 · 刷新'),resize=el('div');
    const preferenceKey='lumos.chat.dock.v1.'+role+'.'+(url.searchParams.get('workspace')||'lingguang');
    let preference=chatDockPreference(null),drag=null;
    try{preference=chatDockPreference(localStorage.getItem(preferenceKey));}catch{}
    const remember=()=>{try{localStorage.setItem(preferenceKey,JSON.stringify(preference));}catch{resize.title='当前宽度仍有效；浏览器未允许保存布局。';}};
    dock.id='workspace-chat';dock.hidden=true;dock.setAttribute('aria-label',heading.textContent);bar.className='workspace-chat-bar';
    close.className='icon-close';close.setAttribute('aria-label','关闭对话');
    frame.title=heading.textContent;open.className='workspace-chat-open primary';open.type=close.type=updated.type='button';open.setAttribute('aria-controls',dock.id);open.setAttribute('aria-expanded','false');
    resize.className='workspace-chat-resize';resize.tabIndex=0;resize.setAttribute('role','separator');resize.setAttribute('aria-label','调整聊天宽度');resize.setAttribute('aria-orientation','vertical');resize.setAttribute('aria-controls',dock.id);resize.title='拖动调整聊天宽度，也可用左右方向键';
    updated.hidden=true;updated.className='workspace-update';bar.append(heading,close);dock.append(resize,bar,frame);document.body.append(dock,open,updated);
    const layout=()=>{const width=chatDockWidth(preference.width,window.innerWidth);document.body.style.setProperty('--workspace-chat-width',width+'px');resize.setAttribute('aria-valuemin',String(Math.min(360,width)));resize.setAttribute('aria-valuemax',String(chatDockWidth(Number.MAX_VALUE,window.innerWidth)));resize.setAttribute('aria-valuenow',String(width));};
    const setWidth=width=>{preference.width=chatDockWidth(width,window.innerWidth);layout();};
    resize.onpointerdown=event=>{if(event.button!==0||window.innerWidth<=800)return;event.preventDefault();resize.focus();drag={id:event.pointerId,x:event.clientX,width:chatDockWidth(preference.width,window.innerWidth)};resize.setPointerCapture(event.pointerId);document.body.classList.add('chat-resizing');};
    resize.onpointermove=event=>{if(drag&&event.pointerId===drag.id)setWidth(drag.width+drag.x-event.clientX);};
    const endResize=()=>{if(!drag)return;const id=drag.id;drag=null;document.body.classList.remove('chat-resizing');if(resize.hasPointerCapture(id))resize.releasePointerCapture(id);remember();};
    resize.onpointerup=resize.onpointercancel=resize.onlostpointercapture=endResize;
    resize.onkeydown=event=>{const width=chatDockWidth(preference.width,window.innerWidth),next={ArrowLeft:width+24,ArrowRight:width-24,Home:360,End:chatDockWidth(Number.MAX_VALUE,window.innerWidth)}[event.key];if(next===undefined||window.innerWidth<=800)return;event.preventDefault();setWidth(next);remember();};
    const syncOverlay=()=>{for(const child of document.body.children)if(child!==dock)child.inert=!dock.hidden&&window.innerWidth<=800;};
    window.addEventListener('resize',()=>{endResize();layout();syncOverlay();});
    const hide=()=>{endResize();dock.hidden=true;preference.open=false;remember();syncOverlay();document.body.classList.remove('chat-docked');open.setAttribute('aria-expanded','false');open.focus();};
    function show(address,focus=true){
      if(address||!frame.getAttribute('src')){const target=new URL(address||'/chat',location.href);target.searchParams.set('role',target.searchParams.get('role')||role);target.searchParams.set('workspace',target.searchParams.get('workspace')||new URL(location.href).searchParams.get('workspace')||'lingguang');target.searchParams.set('embedded','1');
        const next=target.pathname+target.search;if(frame.getAttribute('src')!==next){frame.src=next;heading.textContent='与 '+(roleSpaces[target.searchParams.get('role')]||info).name+' 对话';frame.title=heading.textContent;dock.setAttribute('aria-label',heading.textContent);open.textContent='和 '+(roleSpaces[target.searchParams.get('role')]||info).name+' 聊';}}
      dock.hidden=false;preference.open=true;remember();syncOverlay();document.body.classList.add('chat-docked');open.setAttribute('aria-expanded','true');if(focus)close.focus();
    }
    open.onclick=()=>dock.hidden?show():hide();close.onclick=hide;
    dock.addEventListener('keydown',event=>{if(event.key==='Escape')hide();});
    updated.onclick=()=>{const refresh=document.querySelector('#refresh, #refresh-notes, #refresh-reports');if(refresh)refresh.click();else location.reload();updated.hidden=true;};
    window.addEventListener('message',event=>{if(!trustedChatMessage(event,frame,location.origin))return;if(event.data.lumosChat==='close')hide();else if(event.data.lumosChat==='saved')updated.hidden=false;else window.dispatchEvent(new Event('lumos-attention')); });
    window.addEventListener('lumos-open-chat',event=>show(event.detail));
    // Ordinary chat links open beside the work; links carrying an exact episode keep their own context.
    document.addEventListener('click',event=>{const a=event.target.closest('a');if(!a||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;const target=new URL(a.href);if(target.origin===location.origin&&target.pathname==='/chat'&&!target.searchParams.has('episode')&&!target.searchParams.has('material')&&!target.searchParams.has('id')){event.preventDefault();show(a.href);}});
    layout();if(preference.open)show(undefined,false);
  }
}
