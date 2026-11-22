'use strict';
function noticeText(item){
  if(item.kind!=='ops')return item.text;
  // Keep delivered audit text immutable; translate known system wording only for display.
  return item.text
    .replace(/后续已保存并涉及此主线的回执：([^。]+)。/g,(sentence,refs)=>{
      const ids=refs.match(/intake-[a-f0-9]{32}/g)||[];
      return ids.length&&!refs.replace(/intake-[a-f0-9]{32}|[、，,\s]/g,'')?'已核对 '+new Set(ids).size+' 条相关的后续处理记录。':sentence;
    })
    .replace(/intake-[a-f0-9]{32}/g,'关联处理记录')
    .replaceAll('整理执行器调用了计划外工具，结果未应用。','此前自动整理尝试了未获允许的操作，已被系统拦截；该次结果没有保存。')
    .replaceAll('查看步骤和原输入；核对后重试或重新整理。','需要先核对失败原因和原始内容，再决定如何继续。')
    .replaceAll('后续已保存并涉及此主线的回执：未找到后续回执。','当时未找到可以承接这次工作的后续处理记录。')
    .replaceAll('旧错误只保留了计划外工具拒绝信息，无法从该文字确认具体工具；现执行器禁用普通整理工具，拒绝校验继续保留。','当时记录不足以确认具体原因；系统的操作限制仍然有效。')
    .replaceAll('下一步仅按当前主线及已有未答问题补齐复核；不重放旧候选，不重复已保存的安排，不推定任务完成或关闭未答问题。','当时的接续安排：结合最新项目记录补齐复核，保留待确认问题，避免重复处理。')
    .replaceAll('运行情况已更新：该次处理已成功接续；不代表底层故障已永久修复。','这次中断的整理已接续成功，你无需为此重新提交内容。\n这表示本次工作已恢复，不代表同类故障已永久排除。');
}
function attentionThreads(conversations,role){
  return conversations.filter(n=>(!role||n.data.agent_role===role)&&!n.data.deleted&&n.data.notices?.length).map(n=>({
    id:n.data.chat_id,role:n.data.agent_role,title:n.data.title,workspace:n.data.workspace,
    unread:n.data.notices.filter(i=>i.active&&!i.seen_at).length,
    latest:n.data.notices.filter(i=>i.active).at(-1)||n.data.notices.at(-1)
  })).sort((a,b)=>Number(b.unread>0)-Number(a.unread>0)||b.latest.at.localeCompare(a.latest.at));
}
if(typeof module!=='undefined')module.exports={attentionThreads,noticeText};
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
      for(const n of items){const b=make('button',undefined,'attention-thread'+(n.unread?' is-unread':''));b.type='button';b.append(make('span',(roleSpaces[n.role]?.name||n.role)+' · '+(n.unread?n.unread+' 条未读':n.latest.active?'已读':'已接续'),'attention-meta'),make('strong',n.title),make('span',noticeText(n.latest),'attention-preview'));b.onclick=()=>{const address='/chat?role='+n.role+'&workspace='+n.workspace+'&id='+n.id;panel.close();if(location.pathname==='/chat')location.href=address;else window.dispatchEvent(new CustomEvent('lumos-open-chat',{detail:address}));};list.append(b);}
    }
  }catch{if(current===generation)trigger.textContent='消息 · 暂未连接';}finally{if(current===generation)timer=setTimeout(refresh,5000);}}
  for(const event of ['lumos-attention','lumos-role','lumos-scope'])window.addEventListener(event,refresh);refresh();
}
