const $ = id => document.getElementById(id);
const uid = () => crypto.randomUUID().replaceAll('-', '');
let state, current = null, dirty = false, pending = null, saving = null, timer, remote = null;
let paused = false, historical = false, navigating = false, listRequest = 0, transitioning = false;
let rejectedRequest = null;
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
  try {localStorage.setItem(draftKey(), JSON.stringify({current, values:values(), pending, rejectedRequest}));}
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
        rejectedRequest = draft.rejectedRequest || null;
        fill(draft.values); message('已恢复本地草稿，请核对后点击保存当前内容。');
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
    button.append(node('small', (n.data.status === 'archived' ? '已归档' + (n.data.recording === 'editing' ? ' · 编辑中' : '') : n.data.recording === 'editing' ? '记录中' : n.intake?.data.note_mode==='format' && n.intake.data.status==='done' ? '已润色 · 待归档' : window.LumosIntake?.labels[n.intake?.data.status] || '待处理') + ' · 修改于 ' + new Date(n.data.updated_at).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'Asia/Shanghai'})));
    button.onclick = () => navigate(() => openNote(n.id)); $('note-list').append(button);
  }
  if (!state.notes.length) $('note-list').append(node('p', '这里还没有笔记。'));
  showDrafts();
}
function isReading() {return !dirty && (current?.data.recording === 'finished' || (current?.data.revision > 0 && !current?.data.recording));}
function controls() {
  const deleted=current?.data.status==='deleted';
  for (const id of Object.values(fieldIds)) $(id).disabled = deleted || historical || !state.writable || transitioning || isReading();
  $('save-note').disabled = historical || !state.writable || !!remote;
  $('archive-note').disabled = historical || !state.writable || !!remote;
  $('archive-note').textContent = current?.data.status === 'archived' ? '恢复至未处理' : '手动归档';
  $('archive-note').disabled ||= transitioning || deleted;
  $('lumos-archive').disabled = historical || deleted || !state.writable || !!remote || transitioning || !isReading() || current?.data.status !== 'active';
  $('lumos-archive').disabled ||= !current?.data.formatted_revision;
  $('lumos-archive').title = current?.data.formatted_revision ? '理解全文，更新工作记录并归档' : '请先自动整理当前正文';
  $('restore-note').disabled = historical || deleted || !state.writable || !!remote || transitioning || !(current?.data.original_revision || current?.data.source?.original_revision);
  $('delete-note').disabled = historical || deleted || !state.writable || !!remote || transitioning;
  $('preview-note').disabled = deleted || historical || !state.writable || transitioning || !!remote;
  $('preview-note').textContent = paused && pending?.operation === 'edit' ? '重试进入编辑' : paused && pending?.operation === 'finish' ? '重试自动整理' : isReading() ? '编辑' : current?.data.formatted_revision && !dirty ? '完成编辑' : '自动整理';
  $('format-toolbar').hidden = historical || isReading();
  for (const name of ['heading','subheading','bold','italic','number','letter','bullet']) $('format-'+name).disabled = $('note-body').disabled;
  $('save-note').hidden = isReading();
  $('save-note').disabled ||= transitioning || deleted;
}
function fill(data) {
  if(window.LumosRoleUI)window.LumosRoleUI.scope(current.data.workspace);
  remote = null; $('conflict').hidden = true;
  $('note-related').replaceChildren();
  for (const [k,id] of Object.entries(fieldIds)) $(id).value = data[k] || '';
  $('welcome').hidden=true; $('note-editor').hidden=false;
  const reading = historical || isReading();
  $('body-label').hidden=reading; $('note-preview').hidden=!reading;
  if(reading) renderMarkdown(data.body || '', $('note-preview'));
  $('save-state').textContent = historical ? '历史版本 · 只读' : dirty ? '未保存草稿' : savedState();
  $('note-id').textContent = '笔记：' + current.id;
  $('history-content').replaceChildren(); controls();
  const readProcessed=async()=>{
    const id=current.id, revision=current.data.revision;
    const detail=await api('/api/note?id='+encodeURIComponent(id));
    if(current?.id!==id || current.data.revision!==revision || dirty || historical || transitioning || !isReading())return;
    current=detail.note;fill(current.data);renderHistory(detail);await refreshList();
  };
  if(window.LumosIntake && !historical && (data.status==='active' || (data.status==='archived' && data.archive_mode!=='manual')) && data.recording !== 'editing')window.LumosIntake.watch($('note-intake'),data.workspace,current.id,readProcessed,async listing=>{
    if(!listing)return;const job=listing.intakes.find(n=>n.data.note?.id===current?.id);controls();
    $('lumos-archive').disabled ||= ['pending','running'].includes(job?.data.status);
    if(job?.data.note_mode && ['done','needs_review'].includes(job.data.status) && job.data.note.revision===current?.data.revision)await readProcessed();
  });
  else {window.LumosIntake?.stop();$('note-intake').replaceChildren();}
}
function savedState() {
  if(current.data.status==='deleted')return '已删除 · 历史只读';
  if (current.data.status === 'archived') return isReading() ? '已归档 · 阅读模式' : '已归档 · 编辑中 · 自动保存当前内容';
  return isReading() ? current.data.formatted_revision ? '已自动整理 · 待归档' : '已提交自动整理 · 阅读模式' : '记录中 · 已自动保存';
}
function renderHistory(detail) {
  $('note-related').replaceChildren();
  for(const ref of detail.suggestions||[]){const a=node('a',ref.title);a.href=ref.kind==='action'?'/tasks?task='+encodeURIComponent(ref.id):'/?line='+encodeURIComponent(ref.id);const row=node('p','相关'+(ref.kind==='action'?'任务：':'主线：'));row.append(a);$('note-related').append(row);}
  $('history-content').replaceChildren();
  for (const t of detail.tasks) $('history-content').append(node('p', '关联任务：' + t.title));
  if(window.LumosRoleUI){
    if(!detail.history.length){$('history-content').append(node('p','尚无旧版本；当前内容保留在笔记正文中。'));return;}
    const label=node('label','选择历史版本'),select=node('select'),body=node('article');select.id='note-version-picker';label.append(select);$('history-content').append(label,body);
    for(const [index,h] of detail.history.entries()){const option=node('option','修订 '+h.data.revision+' · '+new Date(h.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' · '+(h.data.source.type==='agent'?'自动整理':'原始记录'));option.value=String(index);select.append(option);}
    const show=()=>{const h=detail.history[Number(select.value)];body.replaceChildren();if(h)body.append(node('p',h.data.source.ref),node('p',h.data.archive_reason||''),node('pre',h.data.title+'\n'+h.data.body));};select.onchange=show;show();return;
  }
  for (const h of detail.history) {
    const fold = document.createElement('details');
    fold.append(node('summary', (h.data.checkpoint === undefined ? '已有历史 · 修订 ' + h.data.revision : h.data.source.type === 'agent' ? 'Lumos润色' : '原始记录') + ' · ' + new Date(h.at).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'}) + ' · ' + (h.data.source.type === 'agent' ? 'Agent' : '用户/来源')),
      node('p', h.data.source.ref), node('p', h.data.archive_reason || ''), node('pre', h.data.title + '\n' + h.data.body));
    $('history-content').append(fold);
  }
}
async function openNote(id, revision) {
  const detail = await api('/api/note?' + new URLSearchParams({id, ...(revision ? {revision} : {})}));
  current=detail.note; dirty=false; pending=null; paused=false; historical=!!revision;
  message(); fill(current.data); renderHistory(detail);
  history.replaceState(null,'','/notes?id=' + encodeURIComponent(id) + (revision ? '&revision='+revision : '')+(window.LumosRoleUI?'&workspace='+current.data.workspace:''));
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
async function save(operation = 'save', confirmed = false) {
  if (saving) {await saving; if (paused) return false; return save(operation, confirmed);}
  if (!current || (!dirty && operation === 'save')) return true;
  if (remote || historical || !state.writable) return false;
  paused=false;
  const snapshot=values();
  // Only replace requests whose rejection was confirmed against the unchanged server revision.
  if (pending && rejectedRequest === pending.request_id) {operation=pending.operation; pending=null; rejectedRequest=null;}
  if (!pending && operation === 'save' && current.data.revision > 0 && current.data.recording !== 'editing'
      && Object.entries(fieldIds).some(([k,id])=>$(id).value !== current.data[k])) operation='edit';
  if (!pending) pending={operation, id:current.id, request_id:uid(), expected_revision:current.data.revision,
    ...(confirmed?{confirmed:true}:{}),changes:['process','restore'].includes(operation)?{}:Object.fromEntries(['title','body','date','workspace','status','archive_reason'].map(k=>[k,snapshot[k]]))};
  stash(); $('save-state').textContent='保存中…';
  saving=(async () => {
    try {
      const result=await api('/api/notes',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':state.token},body:JSON.stringify(pending)});
      const sent={...current.data,...pending.changes}, savedOperation=pending.operation, recoveryKey=current.recoveryKey;
      current=result.note; pending=null;
      // Input remains editable while a request is in flight; never replace newer text with its response.
      dirty=Object.entries(fieldIds).some(([k,id])=>$(id).value !== sent[k]);
      if (dirty) {current.recoveryKey=recoveryKey; stash();} else {
        for (const [k,id] of Object.entries(fieldIds)) $(id).value=current.data[k];
        try {localStorage.removeItem(draftKey()); if(recoveryKey) localStorage.removeItem(recoveryKey);} catch {}
      }
      if(current.data.status==='deleted'){
        window.LumosIntake?.stop();current=null;dirty=false;$('note-editor').hidden=true;$('welcome').hidden=false;
        history.replaceState(null,'','/notes');message('笔记已删除，已引用原文和历史保留。');
        try{await refreshList();}catch(e){message('笔记已删除，列表刷新失败：'+e.message);}return true;
      }
      $('save-state').textContent=dirty?'尚有新内容待保存':savedState();
      $('note-id').textContent='笔记：'+current.id;
      if(!dirty && ['edit','finish','archive','process','restore'].includes(savedOperation)) fill(current.data);
      controls(); message();
      history.replaceState(null,'','/notes?id='+encodeURIComponent(current.id));
      try {await refreshList();} catch(e) {message('内容已保存，列表刷新失败：'+e.message);}
      return true;
    } catch(e) {
      paused=true; stash(); controls(); $('save-state').textContent='保存失败 · 草稿保留'; message(e.message);
      if ([400,409].includes(e.status)) {
        try {
          const detail=await api('/api/note?id='+encodeURIComponent(current.id));
          if (detail.note.data.revision !== current.data.revision) {
            remote=detail.note; $('conflict').hidden=false;
            $('remote-note').textContent=remote.data.date+' · '+remote.data.title+'\n'+remote.data.body+'\n状态：'+remote.data.status;
            controls();
          } else {
            rejectedRequest=pending.request_id; stash();
          }
        } catch(readError) {
          if (current.data.revision === 0 && readError.status === 409 && readError.message === 'Note not found') {
            rejectedRequest=pending.request_id; stash();
          }
        }
      }
      return false;
    }
  })();
  const ok=await saving; saving=null;
  if (ok && dirty && !paused) return save(current.data.recording === 'finished' ? 'edit' : 'save');
  return ok && !dirty;
}
function changed() {
  if (!current || historical) return;
  dirty=true; stash(); $('save-state').textContent='尚未保存'; clearTimeout(timer);
  controls();
  if (!paused && !remote) timer=setTimeout(save,900);
}
function inline(text, target) {
  const re=/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g; let start=0;
  for (const m of text.matchAll(re)) {
    target.append(document.createTextNode(text.slice(start,m.index)));
    if(m[1]) {const a=node('a',m[1]); a.href=m[2]; a.target='_blank'; a.rel='noopener noreferrer'; target.append(a);}
    else target.append(node(m[3]?'strong':'em',m[3]||m[4]));
    start=m.index+m[0].length;
  }
  target.append(document.createTextNode(text.slice(start)));
}
function renderMarkdown(text, target) {
  target.replaceChildren(); let list, listKind;
  for(const line of text.split('\n')) {
    const heading=line.match(/^(#{1,3})\s+(.+)$/), bullet=line.match(/^\s*([-*]|\d+[.)]|[a-zA-Z]+[.)])\s+(.+)$/);
    if (bullet) {
      const kind=/^[-*]$/.test(bullet[1])?'ul':/^\d/.test(bullet[1])?'1':bullet[1][0]===bullet[1][0].toUpperCase()?'A':'a';
      if(!list || kind!==listKind) {list=document.createElement(kind==='ul'?'ul':'ol'); if(kind!=='ul'){list.type=kind;list.start=kind==='1'?parseInt(bullet[1]):letterNumber(bullet[1].slice(0,-1));} target.append(list);listKind=kind;}
      const item=document.createElement('li'); inline(bullet[2],item); list.append(item);
    } else {
      list=null; const p=document.createElement(heading?'h'+(Number(heading[1].length)+1):'p');
      inline(heading?heading[2]:line || '\u00a0',p); target.append(p);
    }
  }
}
for (const id of Object.values(fieldIds)) $(id).addEventListener('input',changed);
function letterNumber(text) {return [...text.toLowerCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-96,0);}
function letterMarker(number) {
  if(!Number.isSafeInteger(number) || number<1)return '';
  let text='';
  while(number>0){number--;text=String.fromCharCode(97+number%26)+text;number=Math.floor(number/26);}
  return text;
}
function replaceSelection(text, start, end, selectStart, selectEnd) {
  const input=$('note-body');
  if(input.disabled || input.value.length-(end-start)+text.length>input.maxLength)return;
  input.setRangeText(text,start,end,'end');
  if(selectStart!==undefined)input.setSelectionRange(selectStart,selectEnd);
  input.focus();changed();
}
function formatText(kind) {
  const input=$('note-body'), start=input.selectionStart, end=input.selectionEnd;
  if(kind==='bold' || kind==='italic') {
    const mark=kind==='bold'?'**':'*', text=input.value.slice(start,end)||'文字';
    replaceSelection(mark+text+mark,start,end,start+mark.length,start+mark.length+text.length);return;
  }
  const from=input.value.lastIndexOf('\n',start-1)+1;
  const tail=input.value.indexOf('\n',Math.max(start,end-1)), to=tail<0?input.value.length:tail;
  const lines=input.value.slice(from,to).split('\n').map((line,i)=>{
    const plain=line.replace(/^(?:#{1,3}\s+|(?:[-*]|\d+[.)]|[a-zA-Z]+[.)])\s+)/,'');
    const prefix=kind==='heading'?'# ':kind==='subheading'?'## ':kind==='number'?(i+1)+'. ':kind==='letter'?letterMarker(i+1)+'. ':'- ';
    return prefix+plain;
  }).join('\n');
  replaceSelection(lines,from,to);
}
for(const kind of ['heading','subheading','bold','italic','number','letter','bullet']) $('format-'+kind).onclick=()=>formatText(kind);
$('note-body').addEventListener('keydown',event=>{
  if(event.isComposing)return;
  if((event.ctrlKey || event.metaKey) && ['b','i'].includes(event.key.toLowerCase())) {
    event.preventDefault();formatText(event.key.toLowerCase()==='b'?'bold':'italic');return;
  }
  const input=$('note-body'), pos=input.selectionStart;
  if(event.key!=='Enter' || event.shiftKey || input.selectionEnd!==pos)return;
  const start=input.value.lastIndexOf('\n',pos-1)+1, line=input.value.slice(start,pos);
  const match=line.match(/^(\s*)([-*]|\d+[.)]|[a-zA-Z]+[.)])\s+(.*)$/);
  if(!match)return;
  event.preventDefault();
  if(!match[3].trim()){replaceSelection('',start,pos);return;}
  const marker=match[2]; let next=marker;
  if(/^\d/.test(marker))next=(parseInt(marker)+1)+marker.slice(-1);
  else if(/^[a-zA-Z]/.test(marker)) {
    next=letterMarker(letterNumber(marker.slice(0,-1))+1);
    if(marker[0]===marker[0].toUpperCase())next=next.toUpperCase();
    if(next)next+=marker.slice(-1);
  }
  replaceSelection('\n'+match[1]+next+' ',pos,pos);
});
$('new-note').onclick=()=>navigate(async()=> {
  current={id:'note-'+uid(),kind:'note',data:{title:'',body:'',date:state.today,workspace:$('note-workspace').value,status:'active',archive_reason:'',revision:0,recording:'editing'}};
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
  const operation = ['edit','finish'].includes(pending?.operation) ? pending.operation : isReading() ? 'edit' : 'finish';
  return navigate(async()=> {
    // Fetch the completed rewrite before unlocking; never start from an old reading snapshot.
    if(operation==='edit' && !pending) await openNote(current.id);
    if(current.data.recording === (operation === 'finish' ? 'finished' : 'editing')) {fill(current.data); return;}
    transitioning=true; controls();
    try {
      dirty=true; stash();
      if(await save(operation)) {
        fill(current.data);
        if($('note-history').open) renderHistory(await api('/api/note?id='+encodeURIComponent(current.id)));
      }
    } finally {transitioning=false; controls();}
  });
};
function confirmNote(operation) {
  const deleting=operation==='delete',restoring=operation==='restore',dialog=$('note-confirm'),trigger=$(operation+'-note');
  dialog.setAttribute('data-operation',operation);
  $('note-confirm-title').textContent=deleting?'删除这篇笔记？':restoring?'恢复自动整理前的原稿？':'手动归档这篇笔记？';
  $('note-confirm-subject').textContent=current.data.title || '未命名笔记';
  $('note-confirm-description').textContent=deleting?'笔记将从列表移除，尚未完成的整理也会停止。':restoring?'当前正文将替换为最近一次自动整理前的原稿，并进入编辑。尚未完成的整理会停止。':'归档后可在「已归档」中找回。Lumos 将停止这篇笔记尚未完成的整理。';
  $('note-confirm-hint').textContent=deleting?'已被任务引用的原文与历史仍会保留。':restoring?'整理版与已有来源引用仍保留在历史中。':'需要更新知识库、主线或任务，请使用「Lumos 归档」。';
  $('note-confirm-submit').textContent=deleting?'确认删除':restoring?'确认恢复':'确认归档';
  dialog.returnValue='';
  return new Promise(resolve=>{
    dialog.onclose=()=>{trigger.focus();resolve(dialog.returnValue==='confirm');};
    dialog.showModal();
  });
}
dismissOnBackdrop($('note-confirm'));
$('restore-note').onclick=()=>pending?.operation==='restore'?navigate(async()=>{}):navigate(async()=> {
  if(!await confirmNote('restore'))return;
  transitioning=true;controls();try{dirty=true;await save('restore');}finally{transitioning=false;controls();}
});
$('archive-note').onclick=()=>pending?.operation==='archive'?navigate(async()=>{}):navigate(async()=> {
  const archive=current.data.status!=='archived';
  if(archive) {
    if(!await confirmNote('archive'))return;
    transitioning=true;controls();try{dirty=true;await save('archive',true);}finally{transitioning=false;controls();}return;
  }
  current.data.status='active'; current.data.archive_reason='';
  dirty=true; stash(); if(await save()) fill(current.data);
});
$('delete-note').onclick=()=>pending?.operation==='delete'?navigate(async()=>{}):navigate(async()=> {
  if(!await confirmNote('delete'))return;
  if(!current.data.revision){current=null;$('note-editor').hidden=true;$('welcome').hidden=false;return;}
  transitioning=true;controls();try{dirty=true;await save('delete',true);}finally{transitioning=false;controls();}
});
$('lumos-archive').onclick=()=>pending?.operation==='process'?navigate(async()=>{}):navigate(async()=> {
  transitioning=true;controls();try{dirty=true;if(await save('process'))message('已交给 Codex Astra 整理，完成后更新工作记录并归档。');}finally{transitioning=false;controls();}
});
$('merge-note').onclick=async()=> {
  if(!remote) return;
  const recoveryKey=current.recoveryKey;
  current=remote; current.recoveryKey=recoveryKey; remote=null; pending=null; $('conflict').hidden=true; dirty=true; controls(); stash(); if(await save(current.data.recording === 'finished' || !current.data.recording ? 'edit' : 'save')) fill(current.data);
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
  try {await refreshList(); const params=new URLSearchParams(location.search); const id=params.get('id')||params.get('note'); if(id) await openNote(id,params.get('revision'));}
  catch(e){message(e.message);}
})();
