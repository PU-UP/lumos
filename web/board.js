const $ = id => document.getElementById(id);
const fields = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'follow_up', 'priority', 'owner', 'group'];
const workspaces = {lingguang: '灵光', lumos: 'Lumos 仓库维护'};
const labels = {todo: '待处理', doing: '进行中', blocked: '受阻', done: '已完成', cancelled: '已取消'};
const priorities = {low: '低', normal: '中', high: '高'};
const ownerName = data => data.owner?.trim() || 'Mango';
let state, editing = null, baseline, pending = null;
let dirty = false, discardArmed = false, saving = false, opening = false;
let editMode = false, savedValues;
let dragging = null, movePending = null;
let taskView = 'list', quickPending = null;
const selectedStatuses = new Set(['todo', 'doing']);
let windowDays = null, sortKey = null, sortDirection = 1;
const columnOf = task => task.data.status === 'cancelled' ? 'done' : task.data.status;
const form = $('form');
const preferencesKey = 'lumos.task-view.v1';

function savePreferences() {
  try {
    localStorage.setItem(preferencesKey, JSON.stringify({workspace: $('workspace').value,
      group: $('group-filter').value, owner: $('owner-filter').value, search: $('search').value,
      statuses: [...selectedStatuses], windowDays, sortKey, sortDirection, taskView}));
    $('preferences-message').textContent = '';
  } catch {
    $('preferences-message').textContent = '浏览器未允许保存偏好；本次筛选仍有效，重新打开后可能需要重设。';
  }
}

function restorePreferences() {
  try {
    const p = JSON.parse(localStorage.getItem(preferencesKey));
    if (!p || typeof p !== 'object' || Array.isArray(p)) return;
    if (Object.hasOwn(workspaces, p.workspace)) $('workspace').value = p.workspace;
    for (const [id, key] of [['group-filter', 'group'], ['owner-filter', 'owner']]) {
      if (typeof p[key] !== 'string') continue;
      $(id).append(new Option(p[key], p[key]));
      $(id).value = p[key];
    }
    if (typeof p.search === 'string') $('search').value = p.search;
    if (Array.isArray(p.statuses) && p.statuses.every(s => Object.hasOwn(labels, s))) {
      selectedStatuses.clear();
      p.statuses.forEach(s => selectedStatuses.add(s));
    }
    if (Number.isInteger(p.windowDays) && p.windowDays >= 0 && p.windowDays <= 36500) {
      $('window-days').value = String(p.windowDays);
      $('window-days').oninput();
    }
    if (['text', 'priority', 'group', 'owner', 'status', 'follow_up', 'due'].includes(p.sortKey)) sortKey = p.sortKey;
    if (p.sortDirection === -1 || p.sortDirection === 1) sortDirection = p.sortDirection;
    if (['list', 'board', 'schedule'].includes(p.taskView)) taskView = p.taskView;
  } catch {
    $('preferences-message').textContent = '未能读取上次的筛选设置，已使用默认设置。';
  }
}

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

function workspaceOf(context) {
  return state.contexts.find(c => c.id === context)?.data.workspace || (context === 'lumos-maintenance' ? 'lumos' : 'lingguang');
}

function workspaceContexts(workspace) {
  return state.contexts.filter(c => workspaceOf(c.id) === workspace);
}

function groupNames(workspace) {
  return [...new Set(state.tasks.filter(t => workspaceOf(t.data.context) === workspace)
    .map(t => t.data.group || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function workspacePeople(workspace) {
  return (state.people || []).filter(p => p.data.workspaces.includes(workspace));
}

function personTeam(data) {
  return (data.team || '其他人员') + (data.team_status === 'proposed' ? '（构思中 · 分组未定）' : '');
}

function ownerOptions(workspace, current = '', teams = false) {
  const groups = new Map(), names = new Set(['Mango']);
  for (const {data} of workspacePeople(workspace)) {
    if (data.title === 'Mango') continue;
    const label = personTeam(data);
    if (!groups.has(label)) {
      const group = element('optgroup'); group.label = label;
      groups.set(label, group);
    }
    groups.get(label).append(new Option(data.title + (data.member_type === 'agent' ? '（Agent）' : ''), data.title));
    names.add(data.title);
  }
  const extra = [...new Set(['Mango', current, ...state.tasks.filter(t => workspaceOf(t.data.context) === workspace)
    .map(t => ownerName(t.data))])].filter(name => name && !names.has(name));
  if (extra.length) {
    const group = element('optgroup'); group.label = '其他负责人';
    group.append(...extra.sort((a, b) => a.localeCompare(b, 'zh-CN')).map(name => new Option(name, name)));
    groups.set('other-owners', group);
  }
  if (!teams) return [new Option('Mango', 'Mango'), ...groups.values()];
  const options = [new Option('Mango', 'Mango')];
  for (const [key, group] of groups) {
    const heading = new Option(group.label, key === 'other-owners' ? '@other' : '@team:' + group.label);
    heading.className = 'owner-team'; options.push(heading);
    for (const member of group.children) options.push(new Option('　' + member.text, member.value));
  }
  return options;
}

function matchesOwner(task, selection) {
  if (!selection) return true;
  if (selection === '@other') return ownerName(task.data) !== 'Mango' && !workspacePeople($('workspace').value).some(p => p.data.title === ownerName(task.data));
  if (!selection.startsWith('@team:')) return ownerName(task.data) === selection;
  return workspacePeople($('workspace').value).some(p => personTeam(p.data) === selection.slice(6)
    && p.data.title === ownerName(task.data));
}

function updateFilters() {
  if (!state) return;
  const workspace = $('workspace').value, selectedGroup = $('group-filter').value;
  const groups = groupNames(workspace);
  $('group-filter').replaceChildren(new Option('全部分组', ''), new Option('未分组', '-'),
    ...groups.map(name => new Option(name, ':' + name)));
  $('group-filter').value = selectedGroup === '-' || groups.includes(selectedGroup.slice(1)) ? selectedGroup : '';
  const selectedOwner = $('owner-filter').value;
  const owners = [...workspacePeople(workspace).map(p => p.data.title), 'Mango', ...state.tasks.filter(t => workspaceOf(t.data.context) === workspace).map(t => ownerName(t.data))];
  $('owner-filter').replaceChildren(new Option('全部负责人', ''), ...ownerOptions(workspace, '', true));
  $('owner-filter').value = (selectedOwner === '@other' || owners.includes(selectedOwner) || workspacePeople(workspace).some(p => '@team:' + personTeam(p.data) === selectedOwner)) ? selectedOwner : '';
  $('new').disabled = !state.writable || !workspaceContexts(workspace).length;
}

function setTaskWorkspace(workspace, context = null) {
  const contexts = workspaceContexts(workspace);
  form.elements.namedItem('workspace').value = workspace;
  const control = form.elements.namedItem('context');
  control.replaceChildren(...contexts.map(c => new Option(c.data.title, c.id)));
  const preferred = workspace === 'lingguang' ? 'work-current' : 'lumos-maintenance';
  control.value = contexts.some(c => c.id === context) ? context
    : contexts.find(c => c.id === preferred)?.id || contexts[0]?.id || '';
  $('group-options').replaceChildren(...groupNames(workspace).map(name => new Option(name, name)));
  const owner = form.elements.namedItem('owner'), selectedOwner = owner.value || 'Mango';
  owner.replaceChildren(...ownerOptions(workspace, selectedOwner));
  owner.value = selectedOwner;
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
  const group = $('group-filter').value;
  const end = new Date(state.today + 'T00:00:00Z');
  if (windowDays !== null) end.setUTCDate(end.getUTCDate() + windowDays);
  const until = end.toISOString().slice(0, 10);
  return state.tasks.filter(t => workspaceOf(t.data.context) === $('workspace').value
    && selectedStatuses.has(t.data.status)
    && (windowDays === null || (t.data.follow_up ? t.data.follow_up <= until : !['done', 'cancelled'].includes(t.data.status)))
    && (!group || (group === '-' ? !t.data.group : t.data.group === group.slice(1)))
    && matchesOwner(t, $('owner-filter').value)
    && [t.data.text, t.data.details, t.data.next_step].join(' ').toLowerCase().includes(query));
}

function columnTasks(tasks, status) {
  const order = state.board_order || state.tasks.map(t => t.id);
  return tasks.filter(t => columnOf(t) === status).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

function followUpHint(data) {
  if (['done', 'cancelled'].includes(data.status)) return {text: '', cls: ''};
  if (!data.follow_up) return {text: '待设置关心时间', cls: 'follow-up-pending'};
  if (data.follow_up === state.today) return {text: '今天', cls: 'follow-up-today'};
  if (data.follow_up && data.follow_up < state.today) {
    const days = Math.round((Date.parse(state.today + 'T00:00:00Z') - Date.parse(data.follow_up + 'T00:00:00Z')) / 86400000);
    return {text: '已过 ' + days + ' 天', cls: 'follow-up-overdue'};
  }
  return {text: '', cls: ''};
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
  if (!state) return;
  const tasks = filtered();
  for (const status of Object.keys(labels)) {
    const selected = selectedStatuses.has(status);
    $('status-' + status).setAttribute('aria-pressed', String(selected));
    $('status-' + status).setAttribute('aria-label', labels[status]);
    $('status-' + status).textContent = (selected ? '✓ ' : '') + labels[status];
  }
  for (const name of ['list', 'board', 'schedule']) $('view-' + name).setAttribute('aria-pressed', String(taskView === name));
  $('view-hint').textContent = taskView === 'list' ? '点击标题查看详情；优先级、当前状态和下次关心时间可直接修改。'
    : taskView === 'schedule' ? '近期安排按下次关心时间分组，沿用上方全部筛选；点击任务查看详情。'
    : '看板沿用上方筛选。拖动卡片切换状态或排序；也可聚焦卡片后按 Alt + 方向键。';
  renderList(tasks);
  renderSchedule(tasks);
  $('board').hidden = taskView !== 'board';
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
      button.append(element('span', t.data.group || '未分组', 'context-label'), element('h4', t.data.text));
      const summary = element('div', undefined, 'card-summary');
      summary.append(element('span', '当前摘要', 'card-section-label'));
      if (t.data.progress && t.data.progress.length <= 300) renderDocument(t.data.progress, summary);
      else summary.append(element('p', t.data.progress ? '进展待整理为简短摘要，请打开详情查看。' : '尚未记录当前进展，请打开详情查看下一步。'));
      button.append(summary);
      button.append(element('p', '下次关心：' + (t.data.follow_up || '未设置') + '\n交付日期：' + (t.data.due || '未约定'), 'card-dates'));
      const hint = followUpHint(t.data);
      if (hint.text) button.append(element('span', hint.text, 'follow-up-label ' + hint.cls));
      if (t.data.status === 'cancelled') button.append(element('span', '已取消', 'tag'));
      const badges = tags(t.attention.filter(item => item !== hint.text));
      badges.append(element('span', ownerName(t.data), 'tag'), priorityTag(t.data));
      button.append(badges);
      button.append(element('span', '查看详情与下一步 →', 'card-detail-link'));
      button.onclick = () => openTask(t.id);
      col.append(button);
    }
    $('board').append(col);
  }
}

function sortedTasks(tasks) {
  const order = state.board_order || state.tasks.map(t => t.id);
  const value = t => sortKey === 'owner' ? ownerName(t.data)
    : sortKey === 'priority' ? ({low: 0, normal: 1, high: 2}[t.data.priority || 'normal'])
    : sortKey === 'status' ? Object.keys(labels).indexOf(t.data.status) : t.data[sortKey] || '';
  return [...tasks].sort((a, b) => {
    const original = order.indexOf(a.id) - order.indexOf(b.id);
    if (!sortKey) return original;
    const av = value(a), bv = value(b);
    // Undated tasks stay visible at the bottom in either date sort direction.
    if (['follow_up', 'due'].includes(sortKey) && (!av || !bv)) return !av === !bv ? original : !av ? 1 : -1;
    const comparison = typeof av === 'number' ? av - bv : av.localeCompare(bv, 'zh-CN', {numeric: true});
    return comparison * sortDirection || original;
  });
}

function scheduleBuckets(tasks, today) {
  const buckets = new Map();
  for (const task of tasks) {
    const date = task.data.follow_up;
    const key = !date ? '未设关心时间' : date < today ? '已过关心时间' : date;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(task);
  }
  const order = key => key === '已过关心时间' ? '0000' : key === '未设关心时间' ? '9999' : key;
  return [...buckets].sort(([a],[b]) => order(a).localeCompare(order(b)));
}

function renderSchedule(tasks) {
  const list = $('schedule-list'); list.hidden = taskView !== 'schedule'; list.replaceChildren();
  for (const [date, items] of scheduleBuckets(tasks, state.today)) {
    const section = element('section', undefined, 'schedule-block');
    section.append(element('h3', date + (date === state.today ? ' · 今天' : '') + ' · ' + items.length + ' 项'));
    for (const task of items) {
      const row = element('div', undefined, 'schedule-task'), button = element('button', task.data.text, 'row-title');
      button.type = 'button'; button.onclick = () => openTask(task.id);
      row.append(button, element('span', ownerName(task.data) + ' · ' + labels[task.data.status] + ' · ' + (task.data.follow_up || '未设关心时间'), 'muted'));
      const hint = followUpHint(task.data);
      if (hint.text) row.append(element('span', hint.text, 'follow-up-label ' + hint.cls));
      section.append(row);
    }
    list.append(section);
  }
  if (!tasks.length) list.append(element('p', '当前筛选下暂无任务，可调整状态、负责人或时间范围。', 'empty'));
}

function renderList(tasks) {
  savePreferences();
  const list = $('task-list');
  list.hidden = taskView !== 'list';
  list.replaceChildren();
  const heading = element('div', undefined, 'task-row list-heading');
  for (const [key, title] of [['text', '任务'], ['priority', '优先级'], ['group', '项目标签'], ['owner', '负责人'], ['status', '当前状态'], ['follow_up', '下次关心时间'], ['due', '交付日期']]) {
    const button = element('button', title + (sortKey === key ? sortDirection === 1 ? ' ↑' : ' ↓' : ' ↕'), 'sort-heading');
    button.type = 'button';
    button.setAttribute('aria-label', title + '排序');
    button.title = '点击切换正序、倒序、原顺序';
    button.setAttribute('aria-pressed', String(sortKey === key));
    button.onclick = () => {
      if (sortKey !== key) { sortKey = key; sortDirection = key === 'priority' ? -1 : 1; }
      else if (sortDirection === (key === 'priority' ? -1 : 1)) sortDirection *= -1;
      else sortKey = null;
      renderList(filtered());
    };
    heading.append(button);
  }
  list.append(heading);
  const items = sortedTasks(tasks);
  if (!items.length) list.append(element('p', selectedStatuses.size
    ? '已筛选：' + [...selectedStatuses].map(s => labels[s]).join('、') + '。暂无符合条件的任务，可调整状态或时间范围。'
    : '尚未选择状态，请点击上方状态按钮（可多选）。', 'empty'));
  for (const t of items) {
    const row = element('div', undefined, 'task-row status-' + t.data.status);
    row.dataset.id = t.id;
    const title = element('button', t.data.text, 'row-title');
    title.type = 'button';
    title.title = [t.data.next_step, ...t.attention, t.data.due ? '交付 ' + t.data.due : ''].filter(Boolean).join('\n');
    title.onclick = () => openTask(t.id);
    const priority = element('select', undefined, 'row-priority priority-' + (t.data.priority || 'normal'));
    priority.append(...Object.entries(priorities).map(([value, label]) => new Option(label, value)));
    priority.value = t.data.priority || 'normal';
    const status = element('select', undefined, 'row-status');
    status.append(...Object.entries(labels).map(([value, label]) => new Option(label, value)));
    status.value = t.data.status;
    const date = element('input', undefined, 'row-date');
    date.type = 'date';
    date.value = t.data.follow_up || '';
    const hint = followUpHint(t.data);
    const dateCell = element('div', undefined, 'follow-up-cell ' + hint.cls);
    dateCell.append(date);
    if (hint.text) dateCell.append(element('small', hint.text));
    for (const [control, key, label] of [[priority, 'priority', '优先级'], [status, 'status', '当前状态'], [date, 'follow_up', '下次关心时间']]) {
      control.setAttribute('aria-label', t.data.text + ' · ' + label);
      control.title = label + ' · 修改即保存';
      control.disabled = !state.writable || saving || !!quickPending;
      control.onchange = () => quickSave(t.id, {[key]: control.value});
    }
    const dueCell = element('span', t.data.due || '未约定', 'row-due');
    dueCell.title = '交付日期：明确约定的成果节点；不随关心时间自动变化';
    const owner = element('span', ownerName(t.data), 'row-owner');
    owner.title = ownerName(t.data);
    row.append(title, priority, element('span', t.data.group || '未分组', 'project-tag'), owner, status, dateCell, dueCell);
    list.append(row);
  }
}

async function quickSave(id, changes) {
  if (saving || opening || !state.writable || $('editor').open) return;
  quickPending ||= {request_id: crypto.randomUUID().replaceAll('-', ''), expected_seq: state.seq, id, changes};
  saving = true;
  $('quick-retry').hidden = true;
  renderList(filtered());
  $('message').textContent = '正在保存…';
  try {
    await api('/api/tasks', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Lumos-Token': state.token},
      body: JSON.stringify(quickPending)});
    quickPending = null;
    const loaded = await refresh();
    $('message').textContent = loaded ? '修改已保存。' : '修改已保存，但列表刷新失败。请点击刷新。';
  } catch (e) {
    $('message').textContent = e.message + '\n尚未确认保存成功。可重试上次修改；若版本冲突，请刷新后核对再修改。';
    $('quick-retry').hidden = false;
  } finally {
    saving = false;
    renderList(filtered());
  }
}

async function refresh() {
  $('refresh').disabled = true;
  try {
    state = await api('/api/tasks');
    updateFilters();
    $('date').textContent = state.today;
    $('sync').textContent = '已读取最新记录';
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

function disclosure(title, parent) {
  const node = element('details', undefined, 'detail-fold');
  node.append(element('summary', title));
  parent.append(node);
  return node;
}

function sourceText(source) {
  if (!source) return '来源未记录';
  const types = {user: '用户陈述', user_report: '用户转述／报告', source: '来源材料', agent: 'Agent 分析／建议'};
  const ref = source.ref.replace(/，request=[a-f0-9]{32}$/, '');
  return (types[source.type] || '来源') + '：' + ref + (source.quote ? '\n原话：' + source.quote : '');
}

function renderDocument(content, parent) {
  // Only headings and lists are formatted; source text never becomes executable HTML.
  let paragraph = [], list = null;
  const flush = () => {
    if (paragraph.length) parent.append(element('p', paragraph.join('\n')));
    paragraph = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/), item = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (heading || item || !line.trim()) flush();
    if (!item) list = null;
    if (heading) parent.append(element('h4', heading[1]));
    else if (item) {
      if (!list) {list = element('ul'); parent.append(list);}
      list.append(element('li', item[1]));
    } else if (line.trim()) paragraph.push(line);
  }
  flush();
}

function renderHistory(detail) {
  $('history').replaceChildren();
  if (!detail) return;
  const background = disclosure('相关资料与脉络背景', $('history'));
  background.append(element('p', '直接关联资料与所属脉络背景分别标注；脉络背景不代表本任务的最新进展。', 'muted'));
  for (const [id, content] of Object.entries(detail.documents)) {
    const info = detail.document_info?.[id];
    const title = info?.title || content.match(/^#\s+(.+)/)?.[1] || id;
    const prefix = info?.relation === 'direct' ? '直接关联' : '脉络背景';
    const archived = ['archived', 'retained'].includes(info?.context_status) ? ' · 历史脉络' : '';
    const doc = disclosure(prefix + ' · ' + title + archived, background);
    if (info) doc.append(element('p', '所属脉络：' + info.context_title, 'muted'));
    renderDocument(content, doc);
  }
  for (const r of detail.related.filter(r => r.kind !== 'document')) {
    const stateLabel = r.data.status === 'superseded' ? '已被替代，仅供追溯' : r.kind === 'decision' ? '用户决定' : '关联记录';
    const title = r.data.title || r.data.text || r.id;
    const record = disclosure(stateLabel + ' · ' + (title.length > 48 ? title.slice(0, 48) + '…' : title), background);
    record.append(element('p', r.data.text || r.data.title), element('p', sourceText(r.data.source), 'muted'));
  }
  if (!Object.keys(detail.documents).length && !detail.related.length) background.append(element('p', '尚无关联资料。'));
  const sources = disclosure('来源与依据', $('history'));
  for (const ref of detail.note_sources || []) {
    const fold = disclosure('笔记 · ' + ref.note.data.title + ' · 版本 ' + ref.revision +
      (ref.current_status === 'archived' ? ' · 已归档' : ''), sources);
    fold.append(element('p', ref.excerpt));
    const link = element('a', '查看引用时的完整笔记');
    link.href = '/notes?id=' + encodeURIComponent(ref.id) + '&revision=' + ref.revision;
    link.target = '_blank'; link.rel = 'noopener'; fold.append(link);
  }
  sources.append(element('h4', '最初来源'), element('p', sourceText(detail.task.data.source)));
  if (detail.task.data.last_source) sources.append(element('h4', '最近修改来源'), element('p', sourceText(detail.task.data.last_source)));
  const history = disclosure('修改历史 · ' + detail.history.length + ' 次', $('history'));
  const names = {text: '任务', context: '背景脉络', status: '状态', next_step: '下一步', progress: '进展',
    details: '背景', due: '交付日期', follow_up: '下次关心时间', follow_up_pending: '待设置关心时间', owner: '负责人', group: '分组',
    priority: '优先级', condition: '完成条件', completion: '完成依据', board_order: '看板顺序', note_refs: '笔记来源'};
  const value = (key, v) => {
    if (v === undefined || v === null || v === '') return '未设置';
    if (key === 'status') return labels[v] || v;
    if (key === 'priority') return priorities[v] || v;
    if (key === 'context') return state.contexts.find(c => c.id === v)?.data.title || v;
    if (key === 'board_order') return '第 ' + (v + 1) + ' 位';
    if (key === 'note_refs') return v.map(r => r.id + ' · 版本 ' + r.revision + '：' + r.excerpt).join('\n') || '未关联';
    if (key === 'completion') return (v.basis === 'user_report' ? '用户报告完成' : v.basis) + '：' + (v.ref || '');
    return String(v);
  };
  for (const h of detail.history) {
    const before = h.before?.data || {}, after = h.after?.data || {};
    const changed = Object.keys(names).filter(k => JSON.stringify(before[k] ?? '') !== JSON.stringify(after[k] ?? ''));
    const title = !h.before ? '创建任务' : changed.map(k => names[k]).join('、') || '来源或记录信息';
    const entry = disclosure(new Date(h.at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'}) + ' · ' + title, history);
    for (const key of changed) {
      entry.append(element('h4', names[key]));
      if (h.before) renderDocument('原：' + value(key, before[key]), disclosure('修改前', entry));
      renderDocument('现：' + value(key, after[key]), disclosure('修改后', entry));
    }
    if (h.reason) entry.append(element('p', '修改原因：' + (h.reason.startsWith('task:') ? '任务更新' : h.reason), 'muted'));
    entry.append(element('p', sourceText(after.last_source || after.source), 'muted'));
  }
}

function setEditMode(enabled) {
  editMode = enabled;
  $('task-view').hidden = enabled;
  $('task-fields').hidden = !enabled;
  $('task-fields').disabled = !enabled;
  for (const k of fields) form.elements.namedItem(k).disabled = !enabled;
  form.elements.namedItem('workspace').disabled = !enabled;
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
  view.append(element('p', workspaces[workspaceOf(data.context)] + ' / ' + (data.group || '未分组'), 'muted'));
  const meta = [labels[data.status], '负责人：' + ownerName(data),
    '交付日期：' + (data.due || '未约定'), '下次关心：' + (data.follow_up || '未设置')].filter(Boolean);
  const badges = tags(meta);
  badges.append(priorityTag(data));
  view.append(badges);
  const hint = followUpHint(data);
  if (hint.text) view.append(element('p', hint.text, 'follow-up-label ' + hint.cls));
  for (const [key, title] of [['progress', '当前摘要'], ['next_step', '下一步'], ['details', '背景与详细内容'], ['condition', '怎样算完成']]) {
    if (!data[key]) continue;
    const longProgress = key === 'progress' && data[key].length > 300;
    const folded = key === 'details' || key === 'condition' || longProgress;
    const section = element(folded ? 'details' : 'section', undefined, 'task-section');
    section.append(element(folded ? 'summary' : 'h3', longProgress ? '详细进展（待整理为当前摘要）' : title));
    renderDocument(data[key], section);
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
    const workspace = detail ? workspaceOf(detail.task.data.context) : $('workspace').value;
    setTaskWorkspace(workspace, detail?.task.data.context);
    const data = detail?.task.data || {context: form.elements.namedItem('context').value,
      group: $('group-filter').value.startsWith(':') ? $('group-filter').value.slice(1) : '',
      status: 'todo', priority: 'normal'};
    for (const k of fields) form.elements.namedItem(k).value = data[k] || (k === 'priority' ? 'normal' : '');
    form.elements.namedItem('owner').replaceChildren(...ownerOptions(workspace, ownerName(data)));
    form.elements.namedItem('owner').value = ownerName(data);
    savedValues = values();
    renderTask({...savedValues, follow_up_pending: data.follow_up_pending});
    setEditMode(!id && state.writable);
    $('form-message').textContent = '';
    $('evidence').hidden = !id;
    $('context-details').open = false;
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
let backdropStart = false;
function outsideEditor(event) {
  if (event.target !== $('editor')) return false;
  const r = $('editor').getBoundingClientRect();
  return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
}
$('editor').addEventListener('pointerdown', event => { backdropStart = outsideEditor(event); });
$('editor').addEventListener('click', event => {
  if (backdropStart && outsideEditor(event)) {
    // Accidental outside clicks must never discard an unsaved edit.
    if (dirty) discardArmed = false;
    closeEditor();
  }
  backdropStart = false;
});
$('close').onclick = closeEditor;
$('edit').onclick = () => {
  if (!state.writable || saving) return;
  pending = null;
  setEditMode(true);
  form.elements.namedItem('text').focus();
};
$('cancel-edit').onclick = () => {
  if (saving) return;
  setTaskWorkspace(workspaceOf(savedValues.context), savedValues.context);
  form.elements.namedItem('owner').replaceChildren(...ownerOptions(workspaceOf(savedValues.context), savedValues.owner));
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
$('refresh').onclick = async () => {
  if (saving) return;
  if (await refresh()) {
    quickPending = null;
    $('quick-retry').hidden = true;
    renderList(filtered());
  }
};
$('quick-retry').onclick = () => quickPending && quickSave(quickPending.id, quickPending.changes);
for (const view of ['list', 'board', 'schedule']) $('view-' + view).onclick = () => {
  taskView = view;
  render();
};
for (const status of Object.keys(labels)) $('status-' + status).onclick = () => {
  if (selectedStatuses.has(status)) selectedStatuses.delete(status);
  else selectedStatuses.add(status);
  render();
};
$('window-days').oninput = () => {
  const raw = $('window-days').value;
  const days = Number(raw);
  if (raw !== '' && (!Number.isInteger(days) || days < 0 || days > 36500)) {
    $('window-hint').textContent = '请输入 0–36500 的整数天数；当前仍保留上次有效筛选。';
    return;
  }
  windowDays = raw === '' ? null : days;
  $('window-hint').textContent = windowDays === null ? '状态可多选；时间留空显示全部日期。'
    : '包含今天至未来第 ' + days + ' 天、此前已到跟进日，以及所有未设置关心时间的未结束任务。';
  if (state) render();
};
$('clear-window').onclick = () => { $('window-days').value = ''; $('window-days').oninput(); };
$('workspace').onchange = () => {
  $('group-filter').value = '';
  $('owner-filter').value = '';
  $('search').value = '';
  updateFilters();
  render();
};
$('group-filter').onchange = render;
form.elements.namedItem('workspace').onchange = () => {
  if (!editMode || saving) return;
  setTaskWorkspace(form.elements.namedItem('workspace').value);
  form.elements.namedItem('group').value = '';
  markDirty();
};
$('owner-filter').onchange = render;
$('search').oninput = () => {if (state) render();};
window.addEventListener('beforeunload', event => {if (dirty || saving) {event.preventDefault(); event.returnValue = '';}});
restorePreferences();
refresh().then(() => {
  const id = new URLSearchParams(window.location?.search || '').get('task');
  if (id && state?.tasks.some(t => t.id === id)) openTask(id);
});
