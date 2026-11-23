'use strict';
// Reuse the existing conversation, including its draft and retry protections.
function trustedChatMessage(event,frame,origin){return event.origin===origin&&event.source===frame.contentWindow&&['saved','close','read'].includes(event.data?.lumosChat);}
function chatDockWidth(preferred,viewport){return viewport<=800?viewport:Math.max(360,Math.min(preferred,viewport-480));}
function chatDockPreference(raw){try{const value=JSON.parse(raw);return {width:Number.isFinite(value?.width)&&value.width>=360?value.width:480,open:value?.open===true};}catch{return {width:480,open:false};}}
function chatSidebarSize(width,available){return width<=64?{mode:'closed',width:0}:width>=available-48?{mode:'full',width:available}:{mode:'split',width:Math.min(Math.max(200,width),Math.max(200,available-360))};}
if(typeof module!=='undefined')module.exports={trustedChatMessage,chatDockWidth,chatDockPreference,chatSidebarSize};
if(typeof document!=='undefined'){
  const url=new URL(location.href),role=pageRole(url),info=roleSpaces[role];
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  if(url.pathname==='/chat'){
    const aside=document.getElementById('chat-history'),toggle=document.getElementById('switch-chat'),layout=document.querySelector('.chat-layout'),conversation=document.getElementById('conversation'),backdrop=document.getElementById('chat-history-backdrop');
    const preferenceKey='lumos.chat.sidebar.v1.'+role+'.'+(url.searchParams.get('workspace')||'lingguang');
    let expanded=false,mode='split',width=280,drag=null;
    try{expanded=localStorage.getItem(preferenceKey)==='true';}catch{}
    const sizeKey=preferenceKey+'.size';
    try{const saved=JSON.parse(localStorage.getItem(sizeKey));if(Number.isFinite(saved?.width)&&saved.width>=200)width=saved.width;if(saved?.mode==='full')mode='full';}catch{}
    const handle=document.getElementById('chat-history-resize'),back=document.getElementById('return-chat');
    const available=()=>{const css=window.getComputedStyle(layout);return layout.getBoundingClientRect().width-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);};
    const remember=()=>{try{localStorage.setItem(preferenceKey,String(expanded));localStorage.setItem(sizeKey,JSON.stringify({width,mode}));}catch{}};
    const narrow=()=>window.innerWidth<700;
    function renderHistory(){
      aside.hidden=!expanded;layout.classList.toggle('history-open',expanded);toggle.setAttribute('aria-expanded',String(expanded));
      layout.classList.toggle('history-full',expanded&&mode==='full');back.hidden=!expanded||mode!=='full';
      const actual=mode==='full'?available():Math.min(width,Math.max(200,available()-360));
      layout.style.setProperty('--chat-history-width',actual+'px');handle.hidden=!expanded;
      handle.setAttribute('aria-valuemin','0');handle.setAttribute('aria-valuemax',String(available()));handle.setAttribute('aria-valuenow',String(expanded?actual:0));
      document.getElementById('history-toggle-label').textContent=expanded?'收起列表':'展开列表';
      toggle.setAttribute('aria-label',expanded?'收起对话列表':'展开对话列表');
      backdrop.hidden=!(expanded&&narrow()&&mode!=='full');conversation.hidden=expanded&&mode==='full';conversation.inert=expanded&&(narrow()||mode==='full');
      window.dispatchEvent(new Event('lumos-chat-visibility'));
    }
    function setHistory(value,focus=false){expanded=value;renderHistory();remember();if(focus)toggle.focus();}
    function returnChat(){mode='split';setHistory(!narrow());document.getElementById('chat-text').focus();}
    back.onclick=returnChat;window.addEventListener('lumos-chat-reply',returnChat);
    const size=value=>{const next=chatSidebarSize(value,available());expanded=next.mode!=='closed';if(expanded)mode=next.mode;if(next.mode==='split')width=next.width;renderHistory();};
    handle.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();handle.focus();drag={id:e.pointerId,x:e.clientX,width:mode==='full'?available():Math.min(width,Math.max(200,available()-360))};handle.setPointerCapture(e.pointerId);layout.classList.add('history-resizing');};
    handle.onpointermove=e=>{if(drag&&e.pointerId===drag.id)size(drag.width+e.clientX-drag.x);};
    const end=()=>{if(!drag)return;const id=drag.id;drag=null;layout.classList.remove('history-resizing');if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);remember();};
    handle.onpointerup=handle.onpointercancel=handle.onlostpointercapture=end;
    handle.onkeydown=e=>{const current=Math.min(width,Math.max(200,available()-360)),next={ArrowLeft:mode==='full'?current:current-24,ArrowRight:current>=available()-360?available():current+24,Home:0,End:available()}[e.key];if(next===undefined)return;e.preventDefault();size(next);remember();if(!expanded)toggle.focus();};
    toggle.onclick=()=>setHistory(!expanded);backdrop.onclick=()=>setHistory(false,true);
    aside.addEventListener('click',event=>{if(event.target.closest('.chat-link, #new-chat')&&(narrow()||mode==='full'))returnChat();});
    window.addEventListener('resize',()=>{end();renderHistory();if(expanded&&narrow()&&conversation.contains(document.activeElement))toggle.focus();});
    document.addEventListener('keydown',event=>{if(event.key!=='Escape'||document.querySelector('dialog[open]'))return;if(expanded){event.preventDefault();setHistory(false,true);}else if(url.searchParams.get('embedded')==='1')parent.postMessage({lumosChat:'close'},location.origin);});
    if(url.searchParams.get('embedded')==='1')document.addEventListener('click',event=>{const a=event.target.closest('a');if(a&&new URL(a.href).pathname!=='/chat')a.target='_top';});
    renderHistory();
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
