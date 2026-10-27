const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID().replaceAll('-', '');
let state, current = null, dirty = false, pending = null, saving = null, timer, remote = null;
let paused = false, historical = false, navigating = false, listRequest = 0;
// A duplicated tab can inherit sessionStorage; each page needs its own draft key.
const tabId = uid();
const fieldIds = {title:'note-title', body:'note-body', date:'note-date'};
const node = (tag, text) => {const n = document.createElement(tag); n.textContent = text; return n;};
function message(text = '') {$('note-message').textContent = text;}
async function api(url, options) {
  const res = await fetch(url, options), data = await res.json();
  if (!res.ok) {const e = new Error(data.error || '读取失败'); e.status = res.status; throw e;}
  return data;
}
function values() {
  return {...current.data, ...Object.fromEntries(Object.entries(fieldIds).map(([k,id]) => [k,$(id).value]))};
}
function draftKey() {return 'lumos-note:' + state.store_id + ':' + tabId + ':' + current.id;}
function stash() {
  if (!current || !dirty) return;
  try {localStorage.setItem(draftKey(), JSON.stringify({current, values:values(), pending}));}
  catch {message('浏览器无法保存恢复草稿。请保持页面打开，及时保存，或复制正文备份。');}
}
function showDrafts() {
  $('drafts').replaceChildren();
  const prefix = 'lumos-note:' + state.store_id + ':';
  try {
    for (const key of Object.keys(localStorage).filter(k => k.startsWith(prefix))) {
      const draft = JSON.parse(localStorage.getItem(key));
      const button = node('button', '恢复草稿 · ' + (draft.values.title || '未命名笔记'));
      button.onclick = () => navigate(async () => {
        current = draft.current; pending = draft.pending; dirty = true; paused = true; historical = false;
        fill(draft.values); message('已恢复本地草稿，请核对后点击立即保存。');
        // Keep the original recovery copy until a confirmed save.
        current.recoveryKey = key;
        stash();
      });
      $('drafts').append(button);
    }
  } catch {message('恢复草稿读取失败，请保留当前正文。');}
}
async function refreshList() {
  const generation = ++listRequest;
  const data = await api('/api/notes?' + new URLSearchParams({workspace:$('note-workspace').value,
    archived:$('note-status').value, query:$('note-search').value}));
  if (generation !== listRequest) return;
  state = data;
  $('new-note').disabled = !state.writable;
  $('note-count').textContent = state.notes.length;
  $('note-list').replaceChildren();
  let day;
  for (const n of state.notes) {
    if (day !== n.data.date) {$('note-list').append(node('h2', n.data.date)); $('note-list').lastChild.className='note-day'; day=n.data.date;}
    const button = node('button', n.data.title); button.className='note-item' + (current?.id === n.id ? ' selected' : '');
    button.append(node('small', '修改于 ' + new Date(n.data.updated_at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'})));
    button.onclick = () => navigate(() => openNote(n.id)); $('note-list').append(button);
  }
  if (!state.notes.length) $('note-list').append(node('p', '这里还没有笔记。'));
  showDrafts();
}
function controls() {
  for (const id of Object.values(fieldIds)) $(id).disabled = historical || !state.writable;
  $('save-note').disabled = historical || !state.writable || !!remote;
  $('archive-note').disabled = historical || !state.writable || !!remote;
  $('archive-note').textContent = current?.data.status === 'archived' ? '恢复' : '归档';
}
function fill(data) {
  remote = null; $('conflict').hidden = true; $('archive-panel').hidden=true;
  for (const [k,id] of Object.entries(fieldIds)) $(id).value = data[k] || '';
  $('welcome').hidden=true; $('note-editor').hidden=false;
  $('body-label').hidden=false; $('note-preview').hidden=true;
  $('preview-note').textContent='阅读'; $('preview-note').setAttribute('aria-pressed','false');
  $('save-state').textContent = historical ? '历史版本 · 只读' : dirty ? '未保存草稿' : current.data.revision ? '已保存' : '输入后自动保存';
  $('note-id').textContent = '笔记：' + current.id + ' · 版本 ' + current.data.revision;
  $('history-content').replaceChildren(); controls();
}
function renderHistory(detail) {
  $('history-content').replaceChildren();
  for (const t of detail.tasks) $('history-content').append(node('p', '关联任务：' + t.title));
  for (const h of detail.history) {
    const fold = document.createElement('details');
    fold.append(node('summary', '版本 ' + h.data.revision + ' · ' + new Date(h.at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) + ' · ' + (h.data.source.type === 'agent' ? 'Agent' : '用户/来源')),
      node('p', h.data.source.ref), node('p', h.data.archive_reason || ''), node('pre', h.data.title + '\n' + h.data.body));
    $('history-content').append(fold);
  }
}
async function openNote(id, revision) {
  const detail = await api('/api/note?' + new URLSearchParams({id, ...(revision ? {revision} : {})}));
  current=detail.note; dirty=false; pending=null; paused=false; historical=!!revision;
  message(); fill(current.data); renderHistory(detail);
  history.replaceState(null,'','/notes?id=' + encodeURIComponent(id) + (revision ? '&revision='+revision : ''));
}
async function navigate(action) {
  if (navigating) return;
  navigating=true;
  try {
    clearTimeout(timer);
    if (dirty && !(await save())) return;
    await action();
  } catch(e) {message(e.message);} finally {navigating=false;}
}
async function save() {
  if (saving) {await saving; if (dirty && !paused) return save(); return !dirty;}
  if (!current || !dirty) return true;
  if (remote || historical || !state.writable) return false;
  paused=false;
  const snapshot=values();
  if (!pending) pending={id:current.id, request_id:uid(), expected_revision:current.data.revision,
    changes:Object.fromEntries(['title','body','date','workspace','status','archive_reason'].map(k=>[k,snapshot[k]]))};
  stash(); $('save-state').textContent='保存中…';
  saving=(async () => {
    try {
      const result=await api('/api/notes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':state.token},body:JSON.stringify(pending)});
      const sent=pending.changes, recoveryKey=current.recoveryKey;
      current=result.note; pending=null;
      // Input remains editable while a request is in flight; never replace newer text with its response.
      dirty=Object.entries(fieldIds).some(([k,id])=>$(id).value !== sent[k]);
      if (dirty) {current.recoveryKey=recoveryKey; stash();} else {
        for (const [k,id] of Object.entries(fieldIds)) $(id).value=current.data[k];
        try {localStorage.removeItem(draftKey()); if(recoveryKey) localStorage.removeItem(recoveryKey);} catch {}
      }
      $('save-state').textContent=dirty?'尚有新内容待保存':'已保存';
      $('note-id').textContent='笔记：'+current.id+' · 版本 '+current.data.revision;
      controls(); message();
      history.replaceState(null,'','/notes?id='+encodeURIComponent(current.id));
      try {await refreshList();} catch(e) {message('内容已保存，列表刷新失败：'+e.message);}
      return true;
    } catch(e) {
      paused=true; stash(); $('save-state').textContent='保存失败 · 草稿保留'; message(e.message);
      if (e.status===409) {
        try {
          const detail=await api('/api/note?id='+encodeURIComponent(current.id));
          if (detail.note.data.revision !== current.data.revision) {
            remote=detail.note; $('conflict').hidden=false;
            $('remote-note').textContent=remote.data.date+' · '+remote.data.title+'\n'+remote.data.body+'\n状态：'+remote.data.status;
            controls();
          }
        } catch {}
      }
      return false;
    }
  })();
  const ok=await saving; saving=null;
  if (ok && dirty && !paused) return save();
  return ok && !dirty;
}
function changed() {
  if (!current || historical) return;
  dirty=true; stash(); $('save-state').textContent='尚未保存'; clearTimeout(timer);
  if (!paused && !remote) timer=setTimeout(save,900);
}
function inline(text, target) {
  const re=/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g; let start=0;
  for (const m of text.matchAll(re)) {
    target.append(document.createTextNode(text.slice(start,m.index)));
    const a=node('a',m[1]); a.href=m[2]; a.target='_blank'; a.rel='noopener noreferrer'; target.append(a); start=m.index+m[0].length;
  }
  target.append(document.createTextNode(text.slice(start)));
}
function renderMarkdown(text, target) {
  target.replaceChildren(); let list;
  for(const line of text.split('\n')) {
    const heading=line.match(/^(#{1,3})\s+(.+)$/), bullet=line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if(!list) {list=document.createElement('ul'); target.append(list);}
      const item=document.createElement('li'); inline(bullet[1],item); list.append(item);
    } else {
      list=null; const p=document.createElement(heading?'h'+(Number(heading[1].length)+1):'p');
      inline(heading?heading[2]:line || '\u00a0',p); target.append(p);
    }
  }
}
for (const id of Object.values(fieldIds)) $(id).addEventListener('input',changed);
$('new-note').onclick=()=>navigate(async()=> {
  current={id:'note-'+uid(),kind:'note',data:{title:'',body:'',date:state.today,workspace:$('note-workspace').value,status:'active',archive_reason:'',revision:0}};
  dirty=false; pending=null; paused=false; historical=false; message(); fill(current.data); $('note-body').focus();
  history.replaceState(null,'','/notes');
});
$('save-note').onclick=()=>save();
$('refresh-notes').onclick=async()=> {
  try {await refreshList(); await navigate(async()=> {if(current?.data.revision) await openNote(current.id,historical?current.data.revision:undefined);});}
  catch(e) {message(e.message);}
};
for(const id of ['note-workspace','note-status','note-search']) $(id).addEventListener(id==='note-search'?'input':'change',()=>refreshList().catch(e=>message(e.message)));
$('preview-note').onclick=()=> {
  const preview=$('note-preview').hidden;
  if(preview) renderMarkdown($('note-body').value,$('note-preview'));
  $('body-label').hidden=preview; $('note-preview').hidden=!preview;
  $('preview-note').textContent=preview?'编辑':'阅读'; $('preview-note').setAttribute('aria-pressed',String(preview));
};
$('archive-note').onclick=()=>navigate(async()=> {
  const archive=current.data.status!=='archived';
  if(archive) {$('archive-panel').hidden=false; $('archive-reason').focus(); return;}
  current.data.status='active'; current.data.archive_reason='';
  dirty=true; stash(); await save();
});
$('cancel-archive').onclick=()=>{$('archive-panel').hidden=true;};
$('confirm-archive').onclick=()=>navigate(async()=> {
  const reason=$('archive-reason').value.trim();
  if(!reason) {message('请填写归档原因。'); return;}
  current.data.status='archived'; current.data.archive_reason=reason;
  dirty=true; stash(); if(await save()) $('archive-panel').hidden=true;
});
$('merge-note').onclick=async()=> {
  if(!remote) return;
  const recoveryKey=current.recoveryKey;
  current=remote; current.recoveryKey=recoveryKey; remote=null; pending=null; $('conflict').hidden=true; dirty=true; controls(); stash(); await save();
};
$('use-remote').onclick=()=> {
  if(!remote) return;
  try {localStorage.removeItem(draftKey()); if(current.recoveryKey)localStorage.removeItem(current.recoveryKey);} catch {}
  current=remote; dirty=false; pending=null; paused=false; fill(current.data); message(); showDrafts();
};
$('note-history').addEventListener('toggle',async()=> {
  if($('note-history').open && current?.data.revision) {
    try {renderHistory(await api('/api/note?id='+encodeURIComponent(current.id)));} catch(e) {message(e.message);}
  }
});
window.addEventListener('beforeunload',e=> {if(dirty || saving){stash(); e.preventDefault(); e.returnValue='';}});
(async()=> {
  try {await refreshList(); const params=new URLSearchParams(location.search); if(params.get('id')) await openNote(params.get('id'),params.get('revision'));}
  catch(e){message(e.message);}
})();
