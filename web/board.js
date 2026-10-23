const $ = id => document.getElementById(id);
const fields = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'follow_up', 'priority', 'owner'];
const labels = {todo: '待处理', doing: '进行中', blocked: '受阻', done: '已完成', cancelled: '已取消'};
const priorities = {low: '低', normal: '中', high: '高'};
const ownerName = data => data.owner?.trim() || 'Mango';
let state, editing = null, baseline, pending = null;
let dirty = false, discardArmed = false, saving = false, opening = false;
let editMode = false, savedValues;
let dragging = null, movePending = null;
const columnOf = task => task.data.status === 'cancelled' ? 'done' : task.data.status;
const form = $('form');

function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '读取失败');
  return data;
}

function contextName(id) {
  return state.contexts.find(c => c.id === id)?.data.title || id;
}

function tags(reasons) {
  const node = element('span', undefined, 'tags');
  reasons.forEach(r => node.append(element('span', r, 'tag' + (r === '已逾期' ? ' urgent' : ''))));
  return node;
}

function priorityTag(data) {
  const priority = data.priority || 'normal';
  return element('span', priorities[priority] + '优先级', 'tag priority-' + priority);
}

function filtered() {
  const query = $('search').value.toLowerCase();
  return state.tasks.filter(t => (!$('context').value || t.data.context === $('context').value)
    && (!$('owner-filter').value || ownerName(t.data) === $('owner-filter').value)
    && [t.data.text, t.data.details, t.data.next_step].join(' ').toLowerCase().includes(query));
}

function columnTasks(tasks, status) {
  const order = state.board_order || state.tasks.map(t => t.id);
  return tasks.filter(t => columnOf(t) === status).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

async function moveTask(id, status, beforeId = null) {
  if (saving || opening || !state.writable || $('editor').open) return;
  const task = state.tasks.find(t => t.id === id);
  if (!task || beforeId === id) return;
  // Reordering the combined closed column must preserve cancellation.
  const targetStatus = columnOf(task) === status ? task.data.status : status;
  const signature = JSON.stringify([id, targetStatus, beforeId, state.seq]);
  if (movePending?.signature !== signature) {
    movePending = {signature, request: {request_id: crypto.randomUUID().replaceAll('-', ''),
      expected_seq: state.seq, id, changes: {status: targetStatus}, before_id: beforeId}};
  }
  saving = true;
  $('message').textContent = '正在保存位置…';
  try {
    await api('/api/tasks', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Lumos-Token': state.token},
      body: JSON.stringify(movePending.request)});
    movePending = null;
    const loaded = await refresh();
    $('message').textContent = loaded ? '卡片位置和状态已保存。' : '已保存，但看板刷新失败。请点击刷新。';
  } catch (e) {
    $('message').textContent = e.message + '\n尚未确认保存成功。网络失败可重复同一拖动重试；记录发生变化时请刷新后核对。';
  } finally {
    saving = false;
  }
}

function dropTarget(col, y) {
  return [...col.querySelectorAll('.card')].find(card => card.dataset.id !== dragging
    && y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2) || null;
}

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-column').forEach(node => node.classList.remove('drop-before', 'drop-column'));
}

function render() {
  const tasks = filtered(), focus = tasks.filter(t => t.attention.length);
  $('focus-count').textContent = focus.length;
  $('focus-list').replaceChildren();
  if (!focus.length) {
    const message = tasks.length ? '暂无触发提醒的事项。没有日期的任务仍保留在下方看板。'
      : state.tasks.length ? '没有符合筛选条件的任务。试试其他关键词或工作脉络。'
      : '还没有任务。写下第一件要做的事，或在对话里告诉我。';
    $('focus-list').append(element('div', message, 'empty'));
  }
  for (const t of focus) {
    const button = element('button', undefined, 'focus-item');
    button.type = 'button';
    const text = element('span');
    text.append(element('span', t.data.text, 'title'), element('small', t.data.next_step || '下一步尚未补充'));
    const badges = tags(t.attention);
    badges.append(element('span', ownerName(t.data), 'tag'), priorityTag(t.data));
    button.append(text, badges);
    button.onclick = () => openTask(t.id);
    $('focus-list').append(button);
  }
  $('board').replaceChildren();
  for (const status of ['todo', 'doing', 'blocked', 'done']) {
    const items = columnTasks(tasks, status);
    const col = element('section', undefined, 'column' + (status === 'done' ? ' closed' : ''));
    col.ondragover = event => {
      if (!dragging || saving || !state.writable) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      col.classList.add('drop-column');
      dropTarget(col, event.clientY)?.classList.add('drop-before');
    };
    col.ondrop = event => {
      if (!dragging) return;
      event.preventDefault();
      const id = dragging, before = dropTarget(col, event.clientY)?.dataset.id || null;
      dragging = null;
      clearDropMarks();
      return moveTask(id, status, before);
    };
    const heading = element('h3', labels[status]);
    heading.append(element('span', items.length));
    col.append(heading);
    if (!items.length) col.append(element('p', '暂无事项', 'empty'));
    for (const t of items) {
      const button = element('button', undefined, 'card');
      button.type = 'button';
      button.dataset.id = t.id;
      button.draggable = state.writable;
      button.title = '拖动调整位置或切换状态；Alt + 方向键也可移动';
      button.ondragstart = event => {
        if (saving || opening || !state.writable || $('editor').open) {event.preventDefault(); return;}
        dragging = t.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', t.id);
        button.classList.add('dragging');
      };
      button.ondragend = () => {dragging = null; button.classList.remove('dragging'); clearDropMarks();};
      button.onkeydown = async event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const index = items.indexOf(t), columns = ['todo', 'doing', 'blocked', 'done'];
        if (event.key === 'ArrowUp' && index > 0) await moveTask(t.id, status, items[index - 1].id);
        if (event.key === 'ArrowDown' && index < items.length - 1) await moveTask(t.id, status, items[index + 2]?.id || null);
        const target = columns[columns.indexOf(status) + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (['ArrowLeft', 'ArrowRight'].includes(event.key) && target) await moveTask(t.id, target);
        [...$('board').querySelectorAll('.card')].find(card => card.dataset.id === t.id)?.focus();
      };
      button.append(element('span', contextName(t.data.context), 'context-label'), element('h4', t.data.text));
      if (t.data.next_step) button.append(element('p', t.data.next_step));
      const dates = [t.data.due ? '截止 ' + t.data.due : '', t.data.follow_up ? '跟进 ' + t.data.follow_up : ''].filter(Boolean);
      button.append(element('p', dates.join(' · ') || '日期未定'));
      if (t.data.status === 'cancelled') button.append(element('span', '已取消', 'tag'));
      const badges = tags(t.attention);
      badges.append(element('span', ownerName(t.data), 'tag'), priorityTag(t.data));
      button.append(badges);
      button.onclick = () => openTask(t.id);
      col.append(button);
    }
    $('board').append(col);
  }
}

async function refresh() {
  $('refresh').disabled = true;
  try {
    state = await api('/api/tasks');
    const selected = $('context').value;
    $('context').replaceChildren(new Option('全部当前工作', ''));
    for (const c of state.contexts) $('context').append(new Option(c.data.title, c.id));
    if (state.contexts.some(c => c.id === selected)) $('context').value = selected;
    const selectedOwner = $('owner-filter').value;
    const owners = [...new Set(state.tasks.map(t => ownerName(t.data)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    $('owner-filter').replaceChildren(new Option('全部负责人', ''), ...owners.map(name => new Option(name, name)));
    $('owner-filter').value = owners.includes(selectedOwner) ? selectedOwner : '';
    $('date').textContent = state.today;
    $('sync').textContent = '已读取最新记录';
    $('new').disabled = !state.writable || !state.contexts.length;
    const drafts = state.integrity.drafts_or_missing_working_copies.length;
    $('message').textContent = !state.writable ? '当前只能查看：可能有未结束的保存会话，或数据处于只读状态。'
      : drafts ? '有尚未吸收的文档变化，请在对话中核对。' : '';
    render();
    return true;
  } catch (e) {
    $('message').textContent = '读取失败：' + e.message;
    $('sync').textContent = '最新记录未能读取';
    return false;
  } finally {
    $('refresh').disabled = false;
  }
}

function values() {
  return Object.fromEntries(fields.map(k => [k, form.elements.namedItem(k).value]));
}

function renderHistory(detail) {
  $('history').replaceChildren();
  if (!detail) return;
  $('history').append(element('pre', '最初来源：' + detail.task.data.source.ref));
  for (const r of detail.related) $('history').append(element('pre', '关联记录：' + (r.data.text || r.data.title)));
  for (const content of Object.values(detail.documents)) $('history').append(element('pre', content));
  for (const h of detail.history) {
    const d = h.after?.data;
    const content = [['任务', d?.text], ['下一步', d?.next_step], ['进展', d?.progress], ['背景', d?.details],
      ['截止', d?.due], ['跟进', d?.follow_up], ['负责人', d?.owner], ['优先级', priorities[d?.priority]], ['完成条件', d?.condition]]
      .filter(([, v]) => v).map(([k, v]) => k + '：' + v).join('\n');
    $('history').append(element('pre', new Date(h.at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})
      + ' · ' + (labels[d?.status] || '') + '\n' + content));
  }
}

function setEditMode(enabled) {
  editMode = enabled;
  $('task-view').hidden = enabled;
  $('task-fields').hidden = !enabled;
  $('task-fields').disabled = !enabled;
  for (const k of fields) form.elements.namedItem(k).disabled = !enabled;
  $('edit-actions').hidden = !enabled;
  $('edit').hidden = enabled;
  $('edit').disabled = !state.writable;
  $('save').disabled = !enabled || !state.writable;
  $('cancel-edit').hidden = !editing;
  $('quick-status').hidden = enabled || !editing;
  for (const button of $('status-buttons').children) {
    button.disabled = !state.writable || button.value === savedValues.status;
  }
  $('editor-title').textContent = enabled ? (editing ? '编辑任务' : '新增任务') : savedValues.text;
}

function renderTask(data) {
  $('status-buttons').replaceChildren();
  for (const [status, label] of Object.entries(labels)) {
    const button = element('button', label, status === data.status ? 'primary' : '');
    button.type = 'button';
    button.value = status;
    button.onclick = () => saveChanges({status}, true);
    $('status-buttons').append(button);
  }
  const view = $('task-view');
  view.replaceChildren();
  view.append(element('p', contextName(data.context), 'muted'));
  const meta = [labels[data.status], '负责人：' + ownerName(data),
    data.due ? '截止 ' + data.due : '', data.follow_up ? '跟进 ' + data.follow_up : ''].filter(Boolean);
  const badges = tags(meta);
  badges.append(priorityTag(data));
  view.append(badges);
  for (const [key, title] of [['next_step', '下一步'], ['progress', '最新进展'], ['details', '背景与详细内容'], ['condition', '怎样算完成']]) {
    if (!data[key]) continue;
    const folded = key === 'details' || key === 'condition';
    const section = element(folded ? 'details' : 'section', undefined, 'task-section');
    section.append(element(folded ? 'summary' : 'h3', title), element('p', data[key]));
    view.append(section);
  }
}

async function openTask(id = null) {
  if (opening || saving || $('editor').open) return;
  opening = true;
  try {
    const detail = id ? await api('/api/task?id=' + encodeURIComponent(id)) : null;
    editing = id;
    baseline = detail ? detail.seq : state.seq;
    pending = null;
    dirty = false;
    discardArmed = false;
    $('close').textContent = '关闭';
    form.reset();
    form.elements.namedItem('context').replaceChildren(...state.contexts.map(c => new Option(c.data.title, c.id)));
    const data = detail?.task.data || {context: $('context').value
      || (state.contexts.some(c => c.id === 'work-current') ? 'work-current' : state.contexts[0]?.id),
      status: 'todo', priority: 'normal'};
    for (const k of fields) form.elements.namedItem(k).value = data[k] || (k === 'priority' ? 'normal' : '');
    form.elements.namedItem('owner').value = ownerName(data);
    savedValues = values();
    renderTask(savedValues);
    setEditMode(!id && state.writable);
    $('form-message').textContent = '';
    $('evidence').hidden = !id;
    $('evidence').open = false;
    renderHistory(detail);
    $('editor').showModal();
  } catch (e) {
    $('message').textContent = e.message;
  } finally {
    opening = false;
  }
}

function closeEditor() {
  if (saving) return;
  if (dirty && !discardArmed) {
    discardArmed = true;
    $('form-message').textContent = '还有未保存的修改。继续编辑，或再次点击关闭以放弃修改。';
    $('close').textContent = '放弃修改并关闭';
    return;
  }
  $('editor').close();
  dirty = false;
  discardArmed = false;
}

function markDirty() {
  if (!editMode) return;
  dirty = true;
  pending = null;
  discardArmed = false;
  $('close').textContent = '关闭';
}
form.addEventListener('input', markDirty);
form.addEventListener('change', markDirty);
form.onsubmit = async event => {
  event.preventDefault();
  await saveChanges(values());
};

async function saveChanges(changes, quick = false) {
  if (saving || !state.writable || (quick ? !editing || editMode : !editMode)) return;
  if (quick && changes.status === savedValues.status) return;
  if (quick && pending?.changes.status !== changes.status) pending = null;
  saving = true;
  for (const control of form.elements) control.disabled = true;
  $('form-message').textContent = '正在保存…';
  try {
    pending ||= {request_id: crypto.randomUUID().replaceAll('-', ''), expected_seq: baseline,
      changes, ...(editing ? {id: editing} : {})};
    const result = await api('/api/tasks', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Lumos-Token': state.token}, body: JSON.stringify(pending)});
    dirty = false;
    $('editor').close();
    const loaded = await refresh();
    if (loaded) $('message').textContent = result.replayed ? '已确认上次保存成功。'
      : quick ? '状态已更新为“' + labels[changes.status] + '”。' : '任务已保存。';
    else $('message').textContent = '任务已保存，但看板刷新失败。请点击刷新读取最新记录。';
  } catch (e) {
    $('form-message').textContent = e.message + (quick
      ? '\n尚未确认状态保存成功。网络失败可再次点击同一状态重试；若记录发生变化，请关闭详情并刷新后核对。'
      : '\n输入已保留。若记录发生变化，请先复制你的修改，关闭详情并刷新后核对；网络失败可直接重试。');
  } finally {
    saving = false;
    for (const control of form.elements) control.disabled = false;
    setEditMode(editMode);
  }
}
$('editor').addEventListener('cancel', event => {event.preventDefault(); closeEditor();});
$('close').onclick = closeEditor;
$('edit').onclick = () => {
  if (!state.writable || saving) return;
  pending = null;
  setEditMode(true);
  form.elements.namedItem('text').focus();
};
$('cancel-edit').onclick = () => {
  if (saving) return;
  for (const k of fields) form.elements.namedItem(k).value = savedValues[k];
  dirty = false;
  discardArmed = false;
  pending = null;
  $('form-message').textContent = '';
  $('close').textContent = '关闭';
  setEditMode(false);
  $('edit').focus();
};
$('new').onclick = () => openTask();
$('refresh').onclick = refresh;
$('context').onchange = render;
$('owner-filter').onchange = render;
$('search').oninput = () => {if (state) render();};
window.addEventListener('beforeunload', event => {if (dirty || saving) {event.preventDefault(); event.returnValue = '';}});
refresh();
