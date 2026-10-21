const $ = id => document.getElementById(id);
const fields = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'follow_up', 'priority'];
const labels = {todo: '待处理', doing: '进行中', blocked: '受阻', done: '已完成', cancelled: '已取消'};
let state, editing = null, baseline, pending = null;
let dirty = false, discardArmed = false, saving = false, opening = false;
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

function filtered() {
  const query = $('search').value.toLowerCase();
  return state.tasks.filter(t => (!$('context').value || t.data.context === $('context').value)
    && [t.data.text, t.data.details, t.data.next_step].join(' ').toLowerCase().includes(query));
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
    button.append(text, tags(t.attention));
    button.onclick = () => openTask(t.id);
    $('focus-list').append(button);
  }
  $('board').replaceChildren();
  for (const status of ['todo', 'doing', 'blocked', 'done']) {
    const items = tasks.filter(t => status === 'done' ? ['done', 'cancelled'].includes(t.data.status) : t.data.status === status);
    const col = element('section', undefined, 'column' + (status === 'done' ? ' closed' : ''));
    const heading = element('h3', labels[status]);
    heading.append(element('span', items.length));
    col.append(heading);
    if (!items.length) col.append(element('p', '暂无事项', 'empty'));
    for (const t of items) {
      const button = element('button', undefined, 'card');
      button.type = 'button';
      button.append(element('span', contextName(t.data.context), 'context-label'), element('h4', t.data.text));
      if (t.data.next_step) button.append(element('p', t.data.next_step));
      const dates = [t.data.due ? '截止 ' + t.data.due : '', t.data.follow_up ? '跟进 ' + t.data.follow_up : ''].filter(Boolean);
      button.append(element('p', dates.join(' · ') || '日期未定'));
      if (t.data.status === 'cancelled') button.append(element('span', '已取消', 'tag'));
      button.append(tags(t.attention));
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
      ['截止', d?.due], ['跟进', d?.follow_up], ['完成条件', d?.condition]]
      .filter(([, v]) => v).map(([k, v]) => k + '：' + v).join('\n');
    $('history').append(element('pre', new Date(h.at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})
      + ' · ' + (labels[d?.status] || '') + '\n' + content));
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
    $('editor-title').textContent = id ? '任务详情' : '新增任务';
    $('form-message').textContent = '';
    $('save').disabled = !state.writable;
    $('evidence').hidden = !id;
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
  dirty = true;
  pending = null;
  discardArmed = false;
  $('close').textContent = '关闭';
}
form.addEventListener('input', markDirty);
form.addEventListener('change', markDirty);
form.onsubmit = async event => {
  event.preventDefault();
  if (saving) return;
  saving = true;
  for (const control of form.elements) control.disabled = true;
  $('form-message').textContent = '正在保存…';
  try {
    pending ||= {request_id: crypto.randomUUID().replaceAll('-', ''), expected_seq: baseline,
      changes: values(), ...(editing ? {id: editing} : {})};
    const result = await api('/api/tasks', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Lumos-Token': state.token}, body: JSON.stringify(pending)});
    dirty = false;
    $('editor').close();
    const loaded = await refresh();
    if (loaded) $('message').textContent = result.replayed ? '已确认上次保存成功。' : '任务已保存。';
    else $('message').textContent = '任务已保存，但看板刷新失败。请点击刷新读取最新记录。';
  } catch (e) {
    $('form-message').textContent = e.message
      + '\n输入已保留。若记录发生变化，请先复制你的修改，关闭详情并刷新后核对；网络失败可直接重试。';
  } finally {
    saving = false;
    for (const control of form.elements) control.disabled = false;
    $('save').disabled = !state?.writable;
  }
};
$('editor').addEventListener('cancel', event => {event.preventDefault(); closeEditor();});
$('close').onclick = closeEditor;
$('new').onclick = () => openTask();
$('refresh').onclick = refresh;
$('context').onchange = render;
$('search').oninput = () => {if (state) render();};
window.addEventListener('beforeunload', event => {if (dirty || saving) {event.preventDefault(); event.returnValue = '';}});
refresh();
