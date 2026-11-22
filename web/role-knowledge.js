'use strict';
function materialState(file){return !file.registrations.length?'已发现 · 尚未登记':file.registrations.some(r=>r.has_text)?'已登记 · 正文可检索':'已登记 · 仅保存原件';}
if(typeof module!=='undefined')module.exports={materialState};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const url=new URL(location.href);
  let token='',contexts=[],hits=[],limit=12,generation=0,sourceGeneration=0,currentMaterial='',pending=null,busy=false;
  const space=()=>$('workspace').value;
  $('workspace').value=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';$('query').value=url.searchParams.get('query')||'';
  $('search-panel').hidden=false;$('material-panel').hidden=false;
  $('page-title').textContent='笔记与资料';$('page-description').textContent='';
  const noteList=$('library-notes');
  $('write-note').href='/notes?role=librarian&workspace='+space()+'&new=1';
  const action=(label,path,params)=>{const a=el('a',label),u=new URL(path,location.href);u.searchParams.set('workspace',space());for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);a.href=u.pathname+u.search;return a;};
  const button=(label,fn)=>{const b=el('button',label);b.type='button';b.onclick=fn;return b;};
  async function request(path){const r=await fetch(path),d=await r.json();if(!r.ok)throw new Error(d.error||'读取失败');return d;}
  function renderHits(){
    const host=$('results');host.replaceChildren();
    for(const [name,filter] of [['文档与项目资料',h=>h.kind==='document'||h.is_material],['笔记',h=>h.kind==='note'],['相关来源',h=>h.kind!=='document'&&!h.is_material&&h.kind!=='note']]){
      const items=hits.slice(0,limit).filter(filter);if(!items.length)continue;
      const section=el('section',undefined,'knowledge-section');section.append(el('h2',name));
      for(const hit of items){const row=el('article',undefined,'knowledge-item');row.append(el('h3',hit.title||'工作来源'),el('p',hit.excerpt||'已保存原件，尚未读取正文。'),el('p',hit.extraction+(hit.truncated?' · 相关片段':''),'knowledge-meta'));
        const actions=el('div',undefined,'material-actions');
        actions.append(button(hit.is_material?'正文与版本':'查看出处',()=>showSource(hit)));
        if(hit.kind==='note')actions.append(action('打开笔记','/notes',{id:hit.id,role:'librarian'}));
        row.append(actions);section.append(row);
      }host.append(section);
    }$('more-results').hidden=hits.length<=limit;
  }
  async function load(){
    const current=++generation,query=$('query').value.trim();hits=[];renderHits();$('status').textContent=query?'正在查找…':'';
    $('material-panel').hidden=!!query;
    const address=new URL(location.href);address.searchParams.set('workspace',space());if(query)address.searchParams.set('query',query);else address.searchParams.delete('query');history.replaceState(null,'',address);
    try{const data=await request('/api/knowledge?workspace='+space()+(query?'&query='+encodeURIComponent(query)+'&archived='+$('archived').checked:'&catalog=true'));if(current!==generation)return;token=data.token;contexts=data.contexts;
      if(query){hits=data.results;renderHits();$('status').textContent=data.total?'找到 '+data.total+' 项'+(data.total>100?'，显示前 100 项。请增加关键词缩小范围。':'。'):'未找到匹配内容，可换关键词或包含已归档内容。';}
      if(!query){
        await files(current);
        const groups=await Promise.all(($('archived').checked?[false,true]:[false]).map(archived=>request('/api/notes?workspace='+space()+'&archived='+archived)));
        if(current!==generation)return;
        noteList.replaceChildren();
        for(const note of groups.flatMap(group=>group.notes)){const row=el('article',undefined,'material-row'),info=el('div');info.append(el('h2',note.data.title||'未命名笔记'),el('p','笔记 · '+note.data.date+(note.data.status==='archived'?' · 已归档':''),'material-state'));row.append(info,action('打开笔记','/notes',{id:note.id,role:'librarian'}));noteList.append(row);}
      }
    }catch(e){if(current===generation){$('status').textContent=e.message+'；请重试。';$('material-status').textContent=e.message+'；请刷新重试。';}}
  }
  async function files(current=generation){
    $('material-status').textContent='正在核对目录与已登记版本…';
    try{const data=await request('/api/materials?workspace='+space());if(current!==generation)return;token=data.token;const host=$('material-list');host.replaceChildren();
      for(const file of data.files){const row=el('article',undefined,'material-row'),info=el('div');info.append(el('h2',file.path),el('p',materialState(file)+' · '+Math.ceil(file.size/1024)+' KB','material-state'));row.append(info);
        const actions=el('div',undefined,'material-actions');actions.append(action('交给 Atlas 查阅','/chat',{agent:'librarian',role:'librarian',material:file.path}));
        for(const r of file.registrations)actions.append(button('已存版本 · '+(contexts.find(c=>c.id===r.context)?.title||r.context),()=>showMaterial(r.id)));
        actions.append(button(file.registrations.length?'登记当前文件':'登记资料',()=>openRegister(file)));row.append(actions);host.append(row);
      }$('material-status').textContent=data.files.length?'':'尚无项目文件；可以先写笔记。';
    }catch(e){if(current===generation)$('material-status').textContent=e.message+'；请刷新重试。';}
  }
  function openRegister(file){
    if(pending){$('register-status').textContent='上次登记尚未确认，请重试原请求。';$('register-dialog').showModal();return;}
    $('register-file').textContent=file.path;$('context').replaceChildren();const empty=el('option','选择所属项目');empty.value='';$('context').append(empty);
    for(const c of contexts){const o=el('option',c.title);o.value=c.id;$('context').append(o);}if(file.registrations.length===1)$('context').value=file.registrations[0].context;
    $('register-status').textContent='';$('register-dialog').showModal();
  }
  $('register-form').onsubmit=async e=>{e.preventDefault();if(busy)return;busy=true;$('register-save').disabled=true;$('context').disabled=true;$('workspace').disabled=true;
    pending||={request_id:crypto.randomUUID().replaceAll('-',''),path:$('register-file').textContent,context:$('context').value};
    try{const r=await fetch('/api/materials',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),d=await r.json();if(!r.ok){if(r.status>=400&&r.status<500)pending=null;throw new Error(d.error||'登记失败');}pending=null;$('register-status').textContent='已登记并同步 Lumos：'+d.material.data.material.extraction;await files();}
    catch(e){$('register-status').textContent=e.message+'；原文件保留，可重试。';}finally{busy=false;$('register-save').disabled=false;$('context').disabled=!!pending;$('workspace').disabled=!!pending;$('register-save').textContent=pending?'重试确认':'登记资料';}
  };
  function showSource(hit){
    if(hit.is_material){showMaterial(hit.id);return;}sourceGeneration++;currentMaterial='';$('version-label').hidden=true;$('source-title').textContent=hit.title||'来源';$('source-status').textContent='来源编号：'+hit.citation.id+(hit.citation.revision?' · 第 '+hit.citation.revision+' 版':'')+(hit.citation.sha256?' · 固定版本 '+hit.citation.sha256:'');$('source-body').textContent=hit.excerpt||'尚未读取正文';$('source-actions').replaceChildren();$('source-dialog').showModal();
  }
  async function showMaterial(id,revision){
    const current=++sourceGeneration;currentMaterial=id;$('source-title').textContent='资料正文与版本';$('source-status').textContent='正在读取固定版本…';$('source-body').replaceChildren();$('source-actions').replaceChildren();if(!$('source-dialog').open)$('source-dialog').showModal();
    try{const d=await request('/api/material?workspace='+space()+'&id='+encodeURIComponent(id)+(revision?'&revision='+revision:''));if(current!==sourceGeneration)return;const n=d.material;$('source-title').textContent=n.data.title;$('source-status').textContent=n.data.material.extraction+' · 来源 '+id+' · SHA256 '+n.data.material.sha256;$('source-body').textContent=n.data.text||'此版本只保存原件，尚未解析正文。';$('version-label').hidden=false;$('source-version').replaceChildren();
      for(const v of d.versions){const o=el('option','第 '+v.revision+' 版 · '+new Date(v.at).toLocaleString('zh-CN'));o.value=String(v.revision);$('source-version').append(o);}$('source-version').value=String(n.data.revision);
      for(const affected of d.affected)$('source-actions').append(action('引用此资料：'+(affected.data.title||affected.data.text),affected.kind==='action'?'/tasks':'/',{role:affected.kind==='action'?'aipm':'lumos',[affected.kind==='action'?'task':'line']:affected.id}));
      if(!d.affected.length)$('source-actions').append(el('p','尚未发现任务或主线直接引用此资料。','material-state'));
    }catch(e){if(current===sourceGeneration)$('source-status').textContent=e.message+'；请重试。';}
  }
  $('source-version').onchange=()=>showMaterial(currentMaterial,$('source-version').value);
  $('close-source').onclick=()=>{sourceGeneration++;$('source-dialog').close();};$('close-register').onclick=()=>$('register-dialog').close();dismissOnBackdrop($('source-dialog'));dismissOnBackdrop($('register-dialog'));
  $('search').onsubmit=e=>{e.preventDefault();limit=12;load();};$('archived').onchange=()=>load();$('workspace').onchange=()=>{sourceGeneration++;$('source-dialog').close();limit=12;load();};$('refresh-materials').onclick=()=>load();$('more-results').onclick=()=>{limit+=12;renderHits();};load().then(()=>{if(url.searchParams.get('material'))showMaterial(url.searchParams.get('material'));});
}
