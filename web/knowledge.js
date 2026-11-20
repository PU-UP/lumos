'use strict';
function knowledgeGroups(hits){
  const groups=[{name:'文档与项目资料',items:[]},{name:'笔记',items:[]},{name:'相关来源',items:[]}];
  for(const hit of hits)groups[hit.kind==='document'||hit.is_material?0:hit.kind==='note'?1:2].items.push(hit);
  return groups.filter(g=>g.items.length);
}
if(typeof module!=='undefined')module.exports={knowledgeGroups};
if(typeof document!=='undefined'){
  const $=id=>document.getElementById(id),el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let token='',pending=null,generation=0,filesLoaded=false,busy=false;
  const url=new URL(location.href);
  $('workspace').value=url.searchParams.get('workspace')==='lumos'?'lumos':'lingguang';
  $('query').value=url.searchParams.get('query')||'';
  function choices(contexts){
    const selected=$('context').value;$('context').replaceChildren();
    for(const c of contexts){const option=el('option',c.title);option.value=c.id;$('context').append(option);}
    if(contexts.some(c=>c.id===selected))$('context').value=selected;
    $('save-material').disabled=busy||!$('context').value||!$('material').value;
  }
  function result(hit){
    const d=el('details');d.className='knowledge-result';
    const title=hit.has_title?hit.title:(hit.context_title||'工作记录')+' · 来源';
    d.append(el('summary',title+(hit.archived?' · 已归档':'')));
    const excerpt=el('p',hit.excerpt||'已保存原件，尚未读取正文。');d.append(excerpt);
    d.append(el('p',hit.extraction+(hit.truncated?'；此处为相关片段':'')));
    const ref=el('details');ref.append(el('summary','出处与版本'),el('p','来源编号：'+hit.citation.id+(hit.citation.revision?' · 第 '+hit.citation.revision+' 版':'')+(hit.citation.sha256?' · 固定版本 '+hit.citation.sha256:'')));d.append(ref);
    if(hit.kind==='note'){const a=el('a','打开笔记');a.href='/notes?workspace='+$('workspace').value+'&id='+encodeURIComponent(hit.id);d.append(a);}
    if(!hit.has_title&&hit.excerpt){const snippet=el('p',hit.excerpt);snippet.className='result-snippet';const row=el('div');row.append(d,snippet);return row;}
    return d;
  }
  async function load(){
    const current=++generation,query=$('query').value.trim(),workspace=$('workspace').value;
    $('results').replaceChildren();
    $('status').textContent=query?'正在查找…':'输入关键词开始查找，也可以在对话中告诉 Lumos 你要找什么。';
    const address=new URL(location.href);query?address.searchParams.set('query',query):address.searchParams.delete('query');history.replaceState(null,'',address);
    try{
      const response=await fetch('/api/knowledge?workspace='+workspace+(query?'&query='+encodeURIComponent(query)+'&archived='+$('archived').checked:'&catalog=true')),data=await response.json();
      if(current!==generation)return;if(!response.ok)throw new Error(data.error||'读取失败');token=data.token;choices(data.contexts);
      if(!query)return;
      const groups=knowledgeGroups(data.results);
      for(const group of groups){
        const section=el('details');section.className='result-group';section.open=group.name!=='相关来源'||groups.length===1;
        section.append(el('summary',group.name+' · '+group.items.length));
        const more=el('details');more.append(el('summary','查看更多匹配内容'));
        group.items.forEach((hit,index)=>(index<8?section:more).append(result(hit)));
        if(group.items.length>8)section.append(more);$('results').append(section);
      }
      $('status').textContent=data.total?'找到 '+data.total+' 项'+(data.total>100?'，已显示前100项，可增加关键词缩小范围。':'。'):'没有找到匹配内容。试试更短的名称或原文关键词，或勾选已归档内容。';
    }catch(e){if(current===generation)$('status').textContent='查找失败：'+e.message+'；请重试。';}
  }
  async function files(){
    if(filesLoaded)return;
    $('material-status').textContent='正在读取项目文件…';
    try{const response=await fetch('/api/materials'),data=await response.json();if(!response.ok)throw new Error(data.error||'读取失败');token=data.token;$('material').replaceChildren();for(const f of data.files){const o=el('option',f.path+' · '+Math.ceil(f.size/1024)+' KB');o.value=f.path;$('material').append(o);}filesLoaded=true;$('material-status').textContent=data.files.length?'选择文件和关联项目后保存。':'项目资料目录中还没有文件。';$('save-material').disabled=busy||!$('context').value||!$('material').value;}catch(e){$('material-status').textContent=e.message+'；重新展开可重试。';}
  }
  $('search').onsubmit=e=>{e.preventDefault();load();};$('workspace').onchange=load;
  $('material-panel').ontoggle=()=>{if($('material-panel').open)files();};
  $('register').onsubmit=async e=>{
    e.preventDefault();if(busy)return;busy=true;$('save-material').disabled=true;
    pending||={request_id:crypto.randomUUID().replaceAll('-',''),path:$('material').value,context:$('context').value};
    for(const id of ['workspace','material','context'])$(id).disabled=true;
    try{const response=await fetch('/api/materials',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':token},body:JSON.stringify(pending)}),data=await response.json();if(!response.ok){if(response.status>=400&&response.status<500)pending=null;throw new Error(data.error||'保存失败');}pending=null;$('material-status').textContent='资料已保存：'+data.material.data.material.extraction;await load();}
    catch(error){$('material-status').textContent=error.message+'；原文件保留，可重试保存。';}
    finally{busy=false;for(const id of ['workspace','material','context'])$(id).disabled=!!pending;$('save-material').disabled=false;$('save-material').textContent=pending?'重试确认保存':'保存资料';}
  };
  load();
}
