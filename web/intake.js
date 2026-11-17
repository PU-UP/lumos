'use strict';
window.LumosIntake = (() => {
  const labels={pending:'待整理',running:'正在整理',failed:'整理失败，原文保留',needs_review:'已整理，有待核对事项',done:'已整理',obsolete:'原文已更新，请整理新版本'};
  const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
  let timer,generation=0;
  async function watch(host,workspace,noteId=null,onFinished=null) {
    clearTimeout(timer);const current=++generation;let wasWorking=false;
    async function refresh() {
      try {
        const response=await fetch('/api/intakes?workspace='+encodeURIComponent(workspace));const data=await response.json();
        if(current!==generation)return;
        if(!response.ok)throw new Error(data.error||'读取失败');
        host.replaceChildren();
        host.append(el('p',!data.enabled?'此空间尚未启用自主整理。':data.executor==='offline'?'整理执行器未运行；内容会保留为待整理。':'结束记录后自动整理；任务及原文可追溯。'));
        const all=data.intakes.filter(n=>!noteId || n.data.note?.id===noteId);
        const jobs=noteId?all.slice(0,1):all;
        if(!jobs.length)host.append(el('p','暂无整理记录。'));
        for(const job of jobs){
          const d=job.data,fold=el('details','');fold.open=!!noteId || ['failed','needs_review'].includes(d.status);
          const submitted=d.created_at?new Date(d.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间未记录';
          const subject=(job.subjects||[]).map(t=>t.title).join('、') || d.title;
          fold.append(el('summary',subject+(d.review?' · 到期复核':'')+' · '+labels[d.status]+' · '+submitted));
          if(d.text)fold.append(el('p',(d.review?'系统复核说明：':'我的反馈：')+d.text));
          if(d.summary)fold.append(el('p','Lumos 处理结果：'+d.summary));
          if(d.error)fold.append(el('p',d.error));
          for(const [index,q] of (d.questions||[]).entries()){
            const answer=(d.resolutions||[]).find(r=>r.index===index);
            fold.append(el('p',answer?'已答复：'+q+' · '+answer.answer:'需核对：'+q));
          }
          if(d.status==='needs_review')fold.append(el('p','可在进展反馈或笔记中补充，Lumos 会接续这些问题。'));
          const record=el('details','');record.append(el('summary','来源与处理去向'));
          if(d.note){const a=el('a','查看原笔记');a.href='/notes?id='+encodeURIComponent(d.note.id)+'&revision='+d.note.revision;record.append(a);}
          else record.append(el('p',d.text));
          for(const target of job.targets||[]){const row=el('p','');if(['action','mainline'].includes(target.kind)){const a=el('a',target.title);a.href=target.kind==='action'?'/tasks?task='+encodeURIComponent(target.id):'/?line='+encodeURIComponent(target.id);row.append(a);}else row.textContent=target.title;record.append(row);}fold.append(record);
          if(d.status==='failed'){
            const retry=el('button','重新整理');
            const request={request_id:crypto.randomUUID().replaceAll('-',''),id:job.id,expected_revision:d.revision};
            retry.onclick=async()=>{retry.disabled=true;try{const r=await fetch('/api/intakes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':data.token},body:JSON.stringify(request)});const result=await r.json();if(!r.ok)throw new Error(result.error);await refresh();}catch(e){fold.append(el('p','未能重试：'+e.message));retry.disabled=false;}};
            fold.append(retry);
          }
          host.append(fold);
        }
        if(noteId && !jobs.length && data.enabled){
          const button=el('button','整理这篇笔记');const request={request_id:crypto.randomUUID().replaceAll('-',''),note_id:noteId};
          button.onclick=async()=>{button.disabled=true;try{const r=await fetch('/api/intakes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':data.token},body:JSON.stringify(request)});const result=await r.json();if(!r.ok)throw new Error(result.error);await refresh();}catch(e){host.append(el('p',e.message));button.disabled=false;}};host.append(button);
        }
        const working=jobs.some(n=>['pending','running'].includes(n.data.status));
        if(working)timer=setTimeout(refresh,5000);
        else if(wasWorking && onFinished)await onFinished();
        wasWorking=working;
      }catch(e){if(current===generation)host.replaceChildren(el('p','整理结果读取失败：'+e.message));}
    }
    await refresh();
  }
  function stop(){generation++;clearTimeout(timer);}
  return {watch,stop,labels};
})();
