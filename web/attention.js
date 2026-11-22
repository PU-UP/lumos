'use strict';
function attentionThreads(conversations,role){
  return conversations.filter(n=>(!role||n.data.agent_role===role)&&!n.data.deleted&&n.data.notices?.length).map(n=>({
    id:n.data.chat_id,role:n.data.agent_role,title:n.data.title,workspace:n.data.workspace,
    unread:n.data.notices.filter(i=>i.active&&!i.seen_at).length,
    latest:n.data.notices.filter(i=>i.active).at(-1)||n.data.notices.at(-1)
  })).sort((a,b)=>Number(b.unread>0)-Number(a.unread>0)||b.latest.at.localeCompare(a.latest.at));
}
if(typeof module!=='undefined')module.exports={attentionThreads};
if(typeof document!=='undefined'&&new URL(location.href).searchParams.get('embedded')!=='1'){
  const make=(tag,text,cls)=>{const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;};
  const trigger=make('button','消息','attention-bubble'),panel=make('dialog',undefined,'attention-panel'),bar=make('div',undefined,'dialog-heading'),title=make('h2','消息'),close=make('button','×','icon-close'),list=make('div');
  close.setAttribute('aria-label','关闭消息');close.onclick=()=>panel.close();bar.append(title,close);panel.append(bar,list);document.body.append(trigger,panel);
  trigger.type=close.type='button';trigger.setAttribute('aria-haspopup','dialog');trigger.onclick=()=>{panel.showModal();refresh();};
  panel.addEventListener('click',event=>{if(event.target!==panel)return;const r=panel.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)panel.close();});
  let signature='',timer,generation=0;
  async function refresh(){clearTimeout(timer);const current=++generation;try{
    const url=new URL(location.href),role=pageRole(url),workspace=url.searchParams.get('workspace')||'lingguang',r=await fetch('/api/conversations?workspace='+workspace),data=await r.json();if(current!==generation)return;if(!r.ok)throw new Error();
    const items=attentionThreads(data.conversations||[],role),count=items.reduce((sum,n)=>sum+n.unread,0);trigger.textContent=count?'消息 · '+count+' 未读':'消息';trigger.classList.toggle('has-unread',count>0);trigger.setAttribute('aria-label',count?'消息，'+count+' 条未读':'消息，无未读');
    title.textContent=roleSpaces[role].name+' 的消息';
    const next=JSON.stringify([role,workspace,items]);if(signature!==next){signature=next;list.replaceChildren();if(!items.length)list.append(make('p',roleSpaces[role].name+' 暂时没有新消息。','muted'));
      for(const n of items){const b=make('button',undefined,'attention-thread'+(n.unread?' is-unread':''));b.type='button';b.append(make('span',(roleSpaces[n.role]?.name||n.role)+' · '+(n.unread?n.unread+' 条未读':n.latest.active?'已读':'已接续'),'attention-meta'),make('strong',n.title),make('span',n.latest.text,'attention-preview'));b.onclick=()=>{const address='/chat?role='+n.role+'&workspace='+n.workspace+'&id='+n.id;panel.close();if(location.pathname==='/chat')location.href=address;else window.dispatchEvent(new CustomEvent('lumos-open-chat',{detail:address}));};list.append(b);}
    }
  }catch{if(current===generation)trigger.textContent='消息 · 暂未连接';}finally{if(current===generation)timer=setTimeout(refresh,5000);}}
  for(const event of ['lumos-attention','lumos-role','lumos-scope'])window.addEventListener(event,refresh);refresh();
}
