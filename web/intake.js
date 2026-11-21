'use strict';
window.LumosIntake = (() => {
  const labels={pending:'待整理',running:'正在整理',failed:'整理失败，原文保留',needs_review:'已整理，有待核对事项',done:'已整理',obsolete:'原文已更新，请整理新版本'};
  const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
  let timer,generation=0;
  async function watch(host,workspace,noteId=null,onFinished=null,onUpdate=null) {
    clearTimeout(timer);const current=++generation;let wasWorking=false;
    async function refresh() {
      try {
        const response=await fetch('/api/intakes?workspace='+encodeURIComponent(workspace));const data=await response.json();
        if(current!==generation)return;
        if(!response.ok)throw new Error(data.error||'读取失败');
        if(onUpdate)await onUpdate(data);
        if(current!==generation)return;
        host.replaceChildren();
        host.append(el('p',!data.enabled?'此空间尚未启用自主整理。':data.executor==='offline'?'整理执行器未运行；内容会保留为待整理。':'自动整理会重写笔记并简短补查疑问；Lumos 归档才更新工作记录。'));
        const all=data.intakes.filter(n=>!noteId || n.data.note?.id===noteId);
        const jobs=noteId?all.slice(0,1):all;
        if(!jobs.length)host.append(el('p','暂无整理记录。'));
        for(const job of jobs){
          const d=job.data,modern=!!window.LumosRoleUI,fold=el(modern?'section':'details',''),key='intake:'+workspace+':'+(noteId||'')+':'+job.id;
          if(modern)fold.className='role-result';else window.LumosDisclosure.remember(fold,key,!!noteId || ['failed','needs_review'].includes(d.status));
          const submitted=d.created_at?new Date(d.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间未记录';
          const subject=(job.subjects||[]).map(t=>t.title).join('、') || d.title;
          fold.append(el(modern?'h3':'summary',subject+(d.note_mode==='format'?' · 笔记自动整理':d.note_mode==='archive'?' · Lumos归档':d.review?' · 到期复核':'')+' · '+labels[d.status]+' · '+submitted));
          if(d.text&&!modern)fold.append(el('p',(d.review?'系统复核说明：':'我的反馈：')+d.text));
          if(d.summary)fold.append(el('p','Lumos 处理结果：'+d.summary));
          for(const ref of d.source_refs||[])fold.append(el('p','已有来源承接：'+ref.title+'（已固定本轮引用）'));
          if(d.error)fold.append(el('p',d.error));
          for(const [index,q] of (d.questions||[]).entries()){
            const answer=(d.resolutions||[]).filter(r=>r.index===index).at(-1);
            fold.append(el('p',!answer?'需核对：'+q:answer.state==='pending'?'剩余待答：'+answer.remaining:answer.state==='waiting'?'等待后续跟进：'+answer.remaining:'原问题已答复：'+answer.answer));
          }
          if(d.status==='needs_review')fold.append(el('p','可在进展反馈或笔记中补充，Lumos 会接续这些问题。'));
          const record=modern?window.LumosRoleUI.panel('来源与保存结果',fold):el('details','');if(!modern){record.append(el('summary','来源与处理去向'));window.LumosDisclosure.remember(record,key+':source');}
          if(d.note){const a=el('a','查看原笔记');a.href='/notes?id='+encodeURIComponent(d.note.id)+'&revision='+d.note.revision;record.append(a);}
          else record.append(el('p',d.text));
          for(const ref of d.source_refs||[])record.append(el('p',ref.title+' · '+ref.id+'\n本轮原话：'+ref.excerpt));
          for(const target of job.targets||[]){const row=el('p','');if(['action','mainline'].includes(target.kind)){const a=el('a',target.title);a.href=target.kind==='action'?'/tasks?task='+encodeURIComponent(target.id):'/?line='+encodeURIComponent(target.id);row.append(a);}else row.textContent=target.title;record.append(row);}if(!modern)fold.append(record);
          if(d.status==='failed'){
            const retry=el('button','重新整理');
            const request={request_id:crypto.randomUUID().replaceAll('-',''),id:job.id,expected_revision:d.revision};
            retry.onclick=async()=>{retry.disabled=true;try{const r=await fetch('/api/intakes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':data.token},body:JSON.stringify(request)});const result=await r.json();if(!r.ok)throw new Error(result.error);await refresh();}catch(e){fold.append(el('p','未能重试：'+e.message));retry.disabled=false;}};
            fold.append(retry);
          }
          host.append(fold);
        }
        const working=jobs.some(n=>['pending','running'].includes(n.data.status));
        if(working)timer=setTimeout(refresh,5000);
        else if(wasWorking && onFinished)await onFinished();
        wasWorking=working;
      }catch(e){if(current===generation){host.replaceChildren(el('p','整理结果读取失败：'+e.message));if(onUpdate)onUpdate(null);timer=setTimeout(refresh,5000);}}
    }
    await refresh();
  }
  function stop(){generation++;clearTimeout(timer);}
  return {watch,stop,labels};
})();
