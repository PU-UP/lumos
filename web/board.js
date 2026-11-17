const $ = id => document.getElementById(id);
const fields = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'completed_on', 'follow_up', 'priority', 'owner', 'group'];
const workspaces = {lingguang: '灵光', lumos: 'Lumos 仓库维护'};
const labels = {todo: '待处理', doing: '进行中', blocked: '受阻', done: '已完成', cancelled: '已取消'};
const priorities = {P3: 'P3', low: '低', normal: '中', high: '高'};
const ownerName = data => data.owner?.trim() || '王牧楠';
const ownerNames = data => ownerName(data).split('、').map(name => name.trim()).filter(Boolean);
let state, editing = null, baseline, pending = null;
let dirty = false, saving = false, opening = false;
let editMode = false, savedValues;
let draftKey, draftBasis, savedBaseline;
const taskDrafts = new Map(), volatileDrafts = new Set();
let taskView = 'list', quickPending = null;
let completionChoice = null;
const selectedStatuses = new Set(['todo', 'doing']);
let windowDays = null, sortKey = null, sortDirection = 1;
const form = $('form');
const preferencesKey = 'lumos.task-view.v1';
let reviewSubmitting=false, reviewTimer;
const reviewTime=value=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});

function renderTaskReview() {
  clearTimeout(reviewTimer);
  const review=state.task_reviews?.[$('workspace').value],job=review?.latest,d=job?.data;
  const running=d && ['pending','running'].includes(d.status);
  $('review-tasks').disabled=reviewSubmitting||!state.writable||!review?.enabled||running;
  $('review-tasks').textContent=running?'Lumos 正在复核…':d?.status==='failed'?'重试任务更新':'Lumos 更新全部任务';
  $('task-review-status').textContent=reviewSubmitting?'正在提交复核请求…':!review?.enabled?'此空间尚未启用任务统筹。':running?(state.executor==='offline'?'复核已排队，执行器恢复后继续。':'正在逐项核对进展、排期和你的手动修改，可离开页面。'):d?.status==='failed'?'本轮未完成：'+d.error:d?.summary||'由 Lumos 维护安排；需要你的关键判断会集中提问。';
  const completed=review?.completed?.data;
  $('task-review-time').textContent=completed?'最近完成复核：'+reviewTime(completed.completed_at)+' · '+completed.task_reviews.length+' 项任务':'尚无全量复核记录';
  const host=$('task-review-content');host.replaceChildren();
  $('task-review-result').hidden=!completed;
  if(completed){host.append(element('p',completed.summary));
    const waiting=state.tasks.filter(t=>workspaceOf(t.data.context)===$('workspace').value && t.management_question);
    const groups=new Map();
    for(const t of waiting){const q=t.management_question,key=q.intake_id+':'+q.index;if(!groups.has(key))groups.set(key,{question:q.question,tasks:[]});groups.get(key).tasks.push(t.short_id||t.data.text);}
    for(const group of groups.values()){const a=element('a',group.tasks.join('、')+'：'+group.question);a.href='/?workspace='+$('workspace').value;host.append(a);}
  }
  if(running)reviewTimer=setTimeout(()=>refresh(),4000);
}

$('review-tasks').onclick=async()=>{
  if($('review-tasks').disabled)return;
  const workspace=$('workspace').value,job=state.task_reviews?.[workspace]?.latest;
  const key='lumos.task-review.request.'+workspace;
  reviewSubmitting=true;renderTaskReview();
  try{
    let request;try{request=JSON.parse(localStorage.getItem(key));}catch{}
    request ||= job?.data.status==='failed'?{request_id:crypto.randomUUID().replaceAll('-',''),id:job.id,expected_revision:job.data.revision}:{request_id:crypto.randomUUID().replaceAll('-',''),workspace};
    try{localStorage.setItem(key,JSON.stringify(request));}catch{}
    await api(request.id?'/api/intakes':'/api/task-review',{method:'POST',headers:{'Content-Type':'application/json','X-Lumos-Token':state.token},body:JSON.stringify(request)});
    try{localStorage.setItem(key,'null');}catch{}
    reviewSubmitting=false;
    await refresh();
  }catch(e){if(e.status>=400&&e.status<500){try{localStorage.setItem(key,'null');}catch{}await refresh();}$('task-review-status').textContent='请求未完成：'+e.message+'。可再次点击重试。';}
  finally{reviewSubmitting=false;$('review-tasks').disabled=!state.writable||['pending','running'].includes(state.task_reviews?.[$('workspace').value]?.latest?.data.status);}
};

function manualBadge(task, fields) {
  const edits=fields.map(k=>[k,task.data.manual_edits?.[k]]).filter(([,v])=>v);
  if(!edits.length)return null;
  const badge=element('small',edits.some(([,v])=>!v.seen_at)?'你改过 · 待复核':'你改过 · 已接续','manual-edit');
  const names={text:'标题',owner:'负责人',follow_up:'关心时间',due:'约定交付',planned_due:'计划交付',completed_on:'完成日期',status:'状态',priority:'优先级',group:'项目标签',context:'关联背景',progress:'进展',next_step:'下一步',details:'背景',condition:'完成条件'};
  badge.title=edits.map(([k,v])=>(names[k]||k)+'：'+(v.value||'已清空')+' · '+reviewTime(v.at)).join('\n');
  return badge;
}

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
    if (p.owner === 'Mango') p.owner = '王牧楠';
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
    if (['list', 'schedule'].includes(p.taskView)) taskView = p.taskView;
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
  if (!res.ok) {const error=new Error(data.error || '读取失败');error.status=res.status;throw error;}
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
  const groups = new Map(), names = new Set(['王牧楠']);
  const archived = new Set((state.archived_people || []).filter(p => p.data.workspaces.includes(workspace)).map(p => p.data.title));
  const selected = current.split('、').map(name => name.trim());
  for (const {data} of workspacePeople(workspace)) {
    if (data.title === '王牧楠') continue;
    const label = personTeam(data);
    if (!groups.has(label)) {
      const group = element('optgroup'); group.label = label;
      groups.set(label, group);
    }
    groups.get(label).append(new Option(data.title + (data.membership_status === 'candidate' ? '（候选 · 未入职）' : data.member_type === 'agent' ? '（Agent）' : ''), data.title));
    names.add(data.title);
  }
  const individuals = state.tasks.filter(t => workspaceOf(t.data.context) === workspace).flatMap(t => ownerNames(t.data));
  const extra = [...new Set([...selected, ...individuals])]
    .filter(name => name && !names.has(name) && (!archived.has(name) || selected.includes(name)));
  if (extra.length) {
    const group = element('optgroup'); group.label = '其他负责人';
    group.append(...extra.sort((a, b) => a.localeCompare(b, 'zh-CN')).map(name => new Option(name, name)));
    groups.set('other-owners', group);
  }
  if (!teams) {
    return [new Option('王牧楠', '王牧楠'), ...groups.values()];
  }
  const options = [new Option('王牧楠', '王牧楠')];
  for (const [key, group] of groups) {
    const heading = new Option(group.label, key === 'other-owners' ? '@other' : '@team:' + group.label);
    heading.className = 'owner-team'; options.push(heading);
    for (const member of group.children) options.push(new Option('　' + member.text, member.value));
  }
  return options;
}

function matchesOwner(task, selection) {
  if (!selection) return true;
  if (selection === '@other') return ownerNames(task.data).some(name => name !== '王牧楠' && !workspacePeople($('workspace').value).some(p => p.data.title === name));
  if (!selection.startsWith('@team:')) return ownerNames(task.data).includes(selection) || ownerName(task.data) === selection;
  return workspacePeople($('workspace').value).some(p => personTeam(p.data) === selection.slice(6)
    && ownerNames(task.data).includes(p.data.title));
}

function updateFilters(rename = null) {
  if (!state) return;
  const workspace = $('workspace').value;
  let selectedGroup = $('group-filter').value;
  if (rename && workspace === rename.workspace && selectedGroup === ':' + rename.previous) {
    selectedGroup = ':' + rename.target;
  }
  const groups = groupNames(workspace);
  $('group-filter').replaceChildren(new Option('全部分组', ''), new Option('未分组', '-'),
    ...groups.map(name => new Option(name, ':' + name)));
  $('group-filter').value = selectedGroup === '-' || groups.includes(selectedGroup.slice(1)) ? selectedGroup : '';
  const selectedOwner = $('owner-filter').value;
  const options = ownerOptions(workspace, '', true);
  $('owner-filter').replaceChildren(new Option('全部负责人', ''), ...options);
  $('owner-filter').value = options.some(option => option.value === selectedOwner) ? selectedOwner : '';
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
  const owner = form.elements.namedItem('owner'), selectedOwner = owner.value || '王牧楠';
  owner.value = selectedOwner;
  renderFormOwner();
}

function renderOwnerEditor(parent, value, workspace, disabled, onChange, label = '任务负责人', inForm = false) {
  parent.replaceChildren();
  const trigger = element('button', value, 'owner-trigger');
  trigger.type = 'button'; trigger.disabled = disabled; trigger.title = value;
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-expanded', 'false');
  const panel = element('div', undefined, 'owner-popover');
  panel.setAttribute('popover', 'auto'); panel.setAttribute('aria-label', '选择负责人');
  for (const event of ['input', 'change']) panel.addEventListener(event, e => e.stopPropagation());
  const selected = element('p', undefined, 'owner-selected'), list = element('div', undefined, 'owner-choices');
  const error = element('p', '', 'owner-error'); error.setAttribute('role', 'alert');
  const checks = [];
  let names;
  const summary = () => {selected.textContent = '已选：' + ([...names].join('、') || '请选择至少一名负责人'); error.textContent = '';};
  for (const option of ownerOptions(workspace, value)) {
    const group = option.tagName === 'OPTGROUP';
    if (group) list.append(element('h3', option.label));
    for (const member of group ? option.children : [option]) {
      const row = element('label'), check = element('input');
      check.type = 'checkbox'; check.value = member.value;
      check.onchange = () => {if (check.checked) names.add(check.value); else names.delete(check.value); summary();};
      row.append(check, element('span', member.text)); list.append(row); checks.push(check);
    }
  }
  const actions = element('div', undefined, 'owner-actions');
  const cancel = element('button', '取消'), apply = element('button', inForm ? '确定' : '保存', 'primary');
  cancel.type = apply.type = 'button';
  cancel.onclick = () => {panel.hidePopover(); trigger.focus();};
  apply.onclick = () => {
    if (!names.size) {error.textContent = '请至少选择一名负责人。'; return;}
    const next = [...names].join('、');
    if (next.length > 300) {error.textContent = '负责人姓名合计不能超过300个字符。'; return;}
    panel.hidePopover(); trigger.focus();
    if (next === value) return;
    value = next; trigger.textContent = value; trigger.title = value;
    return onChange(value);
  };
  actions.append(cancel, apply);
  panel.append(selected, list, error);
  if (inForm) panel.append(element('p', '确定后，随“保存任务”一起保存。', 'muted'));
  panel.append(actions);
  panel.addEventListener('toggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
  trigger.onclick = () => {
    if (panel.matches(':popover-open')) {panel.hidePopover(); return;}
    names = new Set(value.split('、').map(n => n.trim()).filter(Boolean));
    for (const check of checks) check.checked = names.has(check.value);
    summary(); panel.showPopover();
    const rect = trigger.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = Math.max(8, rect.bottom + panel.offsetHeight + 8 <= window.innerHeight
      ? rect.bottom + 4 : rect.top - panel.offsetHeight - 4) + 'px';
    (checks.find(c => c.checked) || checks[0]).focus();
  };
  parent.append(trigger, panel);
}

function renderFormOwner() {
  const owner = form.elements.namedItem('owner');
  renderOwnerEditor($('owner-editor'), owner.value || '王牧楠', form.elements.namedItem('workspace').value,
    !editMode || !state.writable, value => {owner.value = value; markDirty();}, '任务负责人', true);
}

function tags(reasons) {
  const node = element('span', undefined, 'tags');
  reasons.forEach(r => node.append(element('span', r, 'tag' + (r === '已逾期' ? ' urgent' : ''))));
  return node;
}

function priorityTag(data) {
  const priority = data.priority || 'normal';
  return element('span', priorities[priority] + (priority === 'P3' ? ' · 非项目事务' : '优先级'), 'tag priority-' + priority);
}

function isClosed(data) {
  return ['done', 'cancelled'].includes(data.status);
}

function followUpLabel(data) {
  return isClosed(data) ? '不再提醒' : '下次关心：' + (data.follow_up || '未设置');
}

function filtered() {
  const query = $('search').value.toLowerCase();
  const group = $('group-filter').value;
  const end = new Date(state.today + 'T00:00:00Z');
  if (windowDays !== null) end.setUTCDate(end.getUTCDate() + windowDays);
  const until = end.toISOString().slice(0, 10);
  return state.tasks.filter(t => workspaceOf(t.data.context) === $('workspace').value
    && selectedStatuses.has(t.data.status)
    && (windowDays === null || (!isClosed(t.data) && (!t.data.follow_up || t.data.follow_up <= until)))
    && (!group || (group === '-' ? !t.data.group : t.data.group === group.slice(1)))
    && matchesOwner(t, $('owner-filter').value)
    && [t.short_id, t.data.text, t.data.details, t.data.next_step].join(' ').toLowerCase().includes(query));
}

function followUpHint(data) {
  if (['done', 'cancelled'].includes(data.status)) return {text: '', cls: ''};
  if (!data.follow_up) return {text: '待设置关心时间', cls: 'follow-up-pending'};
  if (data.due && data.due !== 'long_term' && data.follow_up > data.due) return data.due < state.today ? {text: '原交付已过 · 待核对结果', cls: 'follow-up-overdue'} : {text: '跟进应提前至交付前', cls: 'date-conflict'};
  if (data.follow_up === state.today) return {text: '今天', cls: 'follow-up-today'};
  if (data.follow_up && data.follow_up < state.today) {
    const days = Math.round((Date.parse(state.today + 'T00:00:00Z') - Date.parse(data.follow_up + 'T00:00:00Z')) / 86400000);
    return {text: '已过 ' + days + ' 天', cls: 'follow-up-overdue'};
  }
  return {text: '', cls: ''};
}

function render() {
  if (!state) return;
  renderTaskReview();
  const tasks = filtered();
  for (const status of Object.keys(labels)) {
    const selected = selectedStatuses.has(status);
    $('status-' + status).setAttribute('aria-pressed', String(selected));
    $('status-' + status).setAttribute('aria-label', labels[status]);
    $('status-' + status).textContent = (selected ? '✓ ' : '') + labels[status];
  }
  for (const name of ['list', 'schedule']) $('view-' + name).setAttribute('aria-pressed', String(taskView === name));
  $('view-hint').textContent = taskView === 'list' ? '点击标题查看详情；可在列表中修改负责人、项目标签、优先级、状态和日期。'
    : '近期安排按下次关心时间分组，沿用上方全部筛选；点击任务查看详情。';
  renderList(tasks);
  renderSchedule(tasks);
}

function sortedTasks(tasks) {
  const order = state.board_order || state.tasks.map(t => t.id);
  const value = t => sortKey === 'owner' ? ownerName(t.data)
    : sortKey === 'priority' ? ({P3: -1, low: 0, normal: 1, high: 2}[t.data.priority || 'normal'])
    : sortKey === 'follow_up' && isClosed(t.data) ? ''
    : sortKey === 'due' && t.data.status === 'done' ? t.data.completed_on || ''
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
    if (isClosed(task.data)) continue;
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
      const deliveryHint = dueHint(task.data);
      row.append(element('span', ' · ' + taskDate(task.data), 'muted'));
      if (deliveryHint.text) row.append(element('span', deliveryHint.text, 'follow-up-label ' + deliveryHint.cls));
      section.append(row);
    }
    list.append(section);
  }
  if (!list.children.length) list.append(element('p', '当前筛选下暂无任务，可调整状态、负责人或时间范围。', 'empty'));
}

function dueLabel(value) { return value === 'long_term' ? '长期' : value || '未约定'; }

function taskDate(data) {
  return data.status === 'done' ? '完成日期：' + (data.completed_on || '未记录') : '交付日期：' + dueLabel(data.due);
}

function chooseCompletionDate(data) {
  $('completion-title').textContent = '完成任务：' + data.text;
  $('complete-today').textContent = '完成当天 · ' + state.today;
  $('complete-due').textContent = '原交付日期 · ' + dueLabel(data.due);
  $('complete-due').disabled = !data.due || data.due === 'long_term';
  return new Promise(resolve => {
    completionChoice = date => {
      completionChoice = null;
      $('completion-picker').close();
      resolve(date);
    };
    $('complete-today').onclick = () => completionChoice(state.today);
    $('complete-due').onclick = () => completionChoice(data.due);
    $('completion-cancel').onclick = () => completionChoice(null);
    $('completion-picker').showModal();
  });
}
$('completion-picker').addEventListener('cancel', event => {event.preventDefault(); completionChoice?.(null);});

function dueHint(data) {
  return !['done', 'cancelled'].includes(data.status) && !data.due && !data.planned_due
    ? {text: '未约定交付时间', cls: 'follow-up-pending'} : {text: '', cls: ''};
}

function renderDueEditor(parent, value, disabled, onChange, planned = '') {
  parent.replaceChildren();
  const trigger = element('button', undefined, 'due-trigger');
  trigger.type = 'button';
  trigger.disabled = disabled;
  trigger.setAttribute('aria-expanded', 'false');
  const label = element('span', dueLabel(value || planned).replaceAll('-', '/'));
  trigger.append(label);
  trigger.setAttribute('aria-label', (value || !planned ? '交付时间：' : '计划交付：') + dueLabel(value || planned) + '，点击修改');
  const panel = element('div', undefined, 'due-popover');
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('aria-label', '选择交付时间');
  const date = element('input');
  date.type = 'date';
  date.value = value && value !== 'long_term' ? value : '';
  date.setAttribute('aria-label', '交付日期');
  date.disabled = disabled;
  const choose = next => {
    panel.hidePopover();
    label.textContent = dueLabel(next).replaceAll('-', '/');
    trigger.setAttribute('aria-label', '交付时间：' + dueLabel(next) + '，点击修改');
    date.value = next && next !== 'long_term' ? next : '';
    trigger.focus();
    onChange(next);
  };
  date.onchange = () => choose(date.value);
  const shortcuts = element('div', undefined, 'due-shortcuts');
  for (const [text, next] of [['未约定', ''], ['长期', 'long_term']]) {
    const button = element('button', text);
    button.type = 'button';
    button.disabled = disabled;
    button.onclick = () => choose(next);
    shortcuts.append(button);
  }
  panel.append(date, shortcuts);
  panel.addEventListener('toggle', event => trigger.setAttribute('aria-expanded', String(event.newState === 'open')));
  trigger.onclick = () => {
    if (panel.matches(':popover-open')) { panel.hidePopover(); return; }
    panel.showPopover();
    const rect = trigger.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(rect.right - panel.offsetWidth, window.innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = Math.max(8, rect.bottom + panel.offsetHeight + 8 <= window.innerHeight
      ? rect.bottom + 4 : rect.top - panel.offsetHeight - 4) + 'px';
    date.focus();
  };
  parent.append(trigger, panel);
}

function renderList(tasks) {
  $('rename-group').disabled = !state.writable || saving || !!quickPending || !$('group-filter').value.startsWith(':');
  savePreferences();
  const list = $('task-list');
  list.hidden = taskView !== 'list';
  list.replaceChildren();
  const heading = element('div', undefined, 'task-row list-heading');
  for (const [key, title] of [['text', '任务'], ['priority', '优先级'], ['group', '项目标签'], ['owner', '负责人'], ['status', '当前状态'], ['follow_up', '下次关心时间'], ['due', '交付 / 完成日期']]) {
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
    if (t.short_id) title.append(element('small', t.short_id, 'task-number'));
    title.type = 'button';
    title.title = [t.data.next_step, ...t.attention, t.data.due ? '交付 ' + dueLabel(t.data.due) : ''].filter(Boolean).join('\n');
    title.onclick = () => openTask(t.id);
    if(t.management_question){const note=element('small','待你回答','task-stewardship');note.title=t.management_question.question;title.append(note);}
    else if(t.management_issues?.length){const note=element('small','Lumos 待复核','task-stewardship');note.title=t.management_issues.join('；');title.append(note);}
    const changed=manualBadge(t,['text','status','priority','group','context','progress','next_step','details','condition']);if(changed)title.append(changed);
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
    if (isClosed(t.data)) {
      date.hidden = true;
      dateCell.append(element('span', labels[t.data.status] + '，不再提醒', 'closed-date'));
    }
    if (hint.text) dateCell.append(element('small', hint.text));
    for (const [control, key, label] of [[priority, 'priority', '优先级'], [status, 'status', '当前状态'], [date, 'follow_up', '下次关心时间']]) {
      control.setAttribute('aria-label', t.data.text + ' · ' + label);
      control.title = (control === priority && t.data.priority === 'P3' ? 'P3 · 非项目事务' : label) + ' · 修改即保存';
      control.disabled = !state.writable || saving || !!quickPending || (control === date && isClosed(t.data));
      control.onchange = () => quickSave(t.id, {[key]: control.value});
    }
    const deliveryHint = dueHint(t.data);
    const dueCell = element('div', undefined, 'row-due follow-up-cell ' + deliveryHint.cls);
    if (t.data.status === 'done') {
      const completed = element('input', undefined, 'row-date');
      completed.type = 'date';
      completed.value = t.data.completed_on || '';
      completed.setAttribute('aria-label', t.data.text + ' · 完成日期');
      completed.disabled = !state.writable || saving || !!quickPending;
      completed.onchange = () => quickSave(t.id, {completed_on: completed.value});
      dueCell.append(completed, element('small', t.data.completed_on ? '完成日期' : '完成日期未记录'));
    } else renderDueEditor(dueCell, t.data.due, !state.writable || saving || !!quickPending, value => quickSave(t.id, {due: value}), t.data.planned_due);
    if (!t.data.due && t.data.planned_due) dueCell.append(element('small', '计划交付', 'planned-target'));
    if (deliveryHint.text) dueCell.append(element('small', '待约定交付时间'));
    dueCell.title = '原交付日期：' + dueLabel(t.data.due) + '；完成日期独立记录';
    const workspace = workspaceOf(t.data.context);
    const owner = element('div', undefined, 'row-owner');
    renderOwnerEditor(owner, ownerName(t.data), workspace, priority.disabled,
      value => quickSave(t.id, {owner: value}), t.data.text + ' · 负责人');
    for(const [cell,keys] of [[owner,['owner']],[dateCell,['follow_up']],[dueCell,['due','planned_due','completed_on']]]){const badge=manualBadge(t,keys);if(badge)cell.append(badge);}
    const group = element('select', undefined, 'project-tag');
    group.append(new Option('未分组', ''), ...groupNames(workspace).map(name => new Option(name, ':' + name)),
      new Option('＋ 新建标签', '+'));
    group.value = t.data.group ? ':' + t.data.group : '';
    group.title = t.data.group || '未分组';
    group.setAttribute('aria-label', t.data.text + ' · 项目标签');
    group.disabled = priority.disabled;
    group.onchange = () => {
      const creating = group.value === '+';
      const name = creating ? window.prompt('新项目标签名称（最多 80 字）')?.trim() : group.value.slice(1);
      group.value = t.data.group ? ':' + t.data.group : '';
      if ((creating && !name) || name === (t.data.group || '')) return;
      return quickSave(t.id, {group: name});
    };
    row.append(title, priority, group, owner, status, dateCell, dueCell);
    list.append(row);
  }
}

const quickFields = {owner: '负责人', group: '项目标签', priority: '优先级', due: '交付时间', follow_up: '下次关心时间', completed_on: '完成日期'};
let noticeTimer, quickFeedback;

function hideSaveNotice() {
  clearTimeout(noticeTimer);
  $('save-notice').hidden = true;
  $('undo-save').onclick = null;
}

function showSaveNotice(text, undo = null, pendingSave = false) {
  clearTimeout(noticeTimer);
  $('save-summary').textContent = text;
  $('undo-save').hidden = !undo;
  $('undo-save').onclick = undo;
  $('save-notice').hidden = false;
  if (!pendingSave) noticeTimer = setTimeout(hideSaveNotice, 7000);
}

function quickValue(field, value) {
  if (field === 'priority') return priorities[value || 'normal'];
  if (field === 'group') return value || '未分组';
  if (field === 'due') return dueLabel(value);
  if (field === 'status') return labels[value];
  return value || (field === 'completed_on' ? '未记录' : '未设置');
}

async function quickSave(id, changes, undoSeq = null, renameGroup = null) {
  if (saving || opening || completionChoice || !state.writable || $('editor').open) return;
  const task = state.tasks.find(t => t.id === id);
  if (!quickPending && changes.status === 'done' && task?.data.status !== 'done') {
    const date = await chooseCompletionDate(task.data);
    if (date === null) {renderList(filtered()); return;}
    changes = {...changes, completed_on: date};
  }
  if (!quickPending) {
    if (changes.group && ([...changes.group].length > 80 || /[\r\n\t]/.test(changes.group))) {
      $('message').textContent = '项目标签须为单行，最多 80 个字。';
      return;
    }
    const field = Object.keys(changes)[0];
    const before = task?.data[field] ?? (field === 'priority' ? 'normal' : '');
    const summary = renameGroup ? '项目标签已改名：' + renameGroup + ' → ' + changes.group : task ? task.data.text + ' · ' + (quickFields[field] || '状态') + '：'
      + quickValue(field, before) + ' → ' + quickValue(field, changes[field]) : '修改已保存。';
    quickFeedback = {text: (undoSeq === null ? '' : '已撤回 · ') + summary,
      inverse: !renameGroup && undoSeq === null && quickFields[field] && before !== changes[field] ? {[field]: before} : null};
    quickPending = {request_id: crypto.randomUUID().replaceAll('-', ''), expected_seq: undoSeq ?? state.seq, id, changes,
      ...(renameGroup ? {rename_group: renameGroup} : {})};
  }
  saving = true;
  $('quick-retry').hidden = true;
  renderList(filtered());
  showSaveNotice('正在保存修改…', null, true);
  try {
    const expected = quickPending.expected_seq;
    const rename = quickPending.rename_group ? {workspace: workspaceOf(task.data.context),
      previous: quickPending.rename_group, target: changes.group} : null;
    const result = await api('/api/tasks', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Lumos-Token': state.token},
      body: JSON.stringify(quickPending)});
    quickPending = null;
    const loaded = await refresh(rename);
    if (loaded) {
      const {text, inverse} = quickFeedback;
      const canUndo = inverse && state.writable && state.seq === result.seq && result.seq === expected + 1;
      showSaveNotice(text, canUndo ? () => quickSave(id, inverse, result.seq) : null);
    } else $('message').textContent = '修改已保存，但列表刷新失败。请点击刷新。';
  } catch (e) {
    hideSaveNotice();
    $('message').textContent = e.message + '\n尚未确认保存成功。可重试上次修改；若版本冲突，请刷新后核对再修改。';
    $('quick-retry').hidden = false;
  } finally {
    saving = false;
    renderList(filtered());
  }
}

async function refresh(rename = null) {
  if (!saving) hideSaveNotice();
  $('refresh').disabled = true;
  try {
    state = await api('/api/tasks');
    updateFilters(rename);
    $('date').textContent = state.today;
    $('sync').textContent = '已读取最新记录';
    const drafts = state.integrity.drafts_or_missing_working_copies.length;
    $('message').textContent = !state.writable ? '当前只能查看：可能有未结束的保存会话，或数据处于只读状态。'
      : drafts ? '有尚未吸收的文档变化，请在对话中核对。' : '';
    render();
    return true;
  } catch (e) {
    hideSaveNotice();
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

function writeTaskDraft(draft) {
  taskDrafts.set(draftKey, draft);
  try {
    localStorage.setItem(draftKey, JSON.stringify(draft));
    volatileDrafts.delete(draftKey);
  } catch {
    volatileDrafts.add(draftKey);
    $('message').textContent = '浏览器暂时无法保存草稿，内容仍保留在本页；请勿刷新或关闭浏览器。';
  }
}
function keepTaskDraft() {
  if (dirty) writeTaskDraft({values:values(), base:draftBasis, baseline, pending,
    workspace:form.elements.namedItem('workspace').value});
}
function restoreTaskDraft() {
  let draft=taskDrafts.get(draftKey);
  if (!taskDrafts.has(draftKey)) {
    try { draft=JSON.parse(localStorage.getItem(draftKey)); } catch { return; }
  }
  if (!draft || !draft.values || !draft.base || !Number.isInteger(draft.baseline)
      || !Object.hasOwn(workspaces,draft.workspace)
      || !fields.every(k=>typeof draft.values[k]==='string' && typeof draft.base[k]==='string')) return;
  const changed=fields.some(k=>draft.base[k]!==savedValues[k]);
  // Never silently rebase stale edits over a changed task, or replace an uncertain save request.
  if (changed || draft.pending) baseline=draft.baseline;
  draftBasis=changed?draft.base:savedValues;
  pending=draft.pending||null;
  setTaskWorkspace(draft.workspace,draft.values.context);
  for (const k of fields) form.elements.namedItem(k).value=draft.values[k];
  dirty=true;
  setEditMode(state.writable);
  $('form-message').textContent=changed
    ? '已恢复草稿；任务记录已有变化。草稿保留原版本检查，请核对最新详情后再保存，或放弃草稿重新编辑。'
    : '已恢复未提交的草稿，可继续编辑。';
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
  if(detail.task.data.planned_due)sources.append(element('p','Lumos目标：'+detail.task.data.planned_due+' · '+(detail.task.data.planning_reason||'')));
  if(detail.task.data.owner_basis==='agent')sources.append(element('p','负责人由Lumos安排：'+detail.task.data.owner+' · '+(detail.task.data.owner_reason||'')));
  if(detail.task.data.review_basis==='agent')sources.append(element('p','关心时间由Lumos安排：'+detail.task.data.follow_up+' · '+(detail.task.data.review_reason||'')));
  if (detail.task.data.last_source) sources.append(element('h4', '最近修改来源'), element('p', sourceText(detail.task.data.last_source)));
  const history = disclosure('修改历史 · ' + detail.history.length + ' 次', $('history'));
  const names = {text: '任务', context: '背景脉络', status: '状态', next_step: '下一步', progress: '进展',
    details: '背景', due: '交付日期', completed_on: '完成日期', follow_up: '下次关心时间', follow_up_pending: '待设置关心时间', owner: '负责人', group: '分组',
    priority: '优先级', condition: '完成条件', completion: '完成依据', board_order: '看板顺序', note_refs: '笔记来源'};
  const value = (key, v) => {
    if (v === undefined || v === null || v === '') return '未设置';
    if (key === 'due') return dueLabel(v);
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
  form.elements.namedItem('follow_up').disabled = !enabled || isClosed(savedValues);
  form.elements.namedItem('workspace').disabled = !enabled;
  $('edit-actions').hidden = !enabled;
  $('edit').hidden = enabled;
  $('edit').disabled = !state.writable;
  $('save').disabled = !enabled || !state.writable;
  $('cancel-edit').hidden = !enabled;
  $('quick-status').hidden = enabled || !editing;
  for (const button of $('status-buttons').children) {
    button.disabled = !state.writable || button.value === savedValues.status;
  }
  $('editor-title').textContent = enabled ? (editing ? '编辑任务' : '新增任务') : savedValues.text;
  $('follow-up-field').hidden = isClosed(savedValues);
  $('completed-field').hidden = savedValues.status !== 'done';
  renderFormOwner();
  renderDueEditor($('due-editor'), form.elements.namedItem('due').value, !enabled || !state.writable, value => {
    form.elements.namedItem('due').value = value;
    markDirty();
  });
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
    taskDate(data), ...(data.status === 'done' ? ['原交付日期：' + dueLabel(data.due)] : []), followUpLabel(data),
    isClosed(data) && data.follow_up && '关闭前的关心日期：' + data.follow_up].filter(Boolean);
  const badges = tags(meta);
  badges.append(priorityTag(data));
  view.append(badges);
  if(data.planned_due)view.append(element('p','Lumos目标：'+data.planned_due+' · '+(data.planning_reason||''),'muted'));
  if(data.owner_basis==='agent')view.append(element('p','负责人由Lumos安排 · '+(data.owner_reason||''),'muted'));
  const hint = followUpHint(data);
  if (hint.text) view.append(element('p', hint.text, 'follow-up-label ' + hint.cls));
  const deliveryHint = dueHint(data);
  if (deliveryHint.text) view.append(element('p', deliveryHint.text, 'follow-up-label ' + deliveryHint.cls));
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
  if (opening || saving || completionChoice || $('editor').open) return;
  opening = true;
  try {
    const detail = id ? await api('/api/task?id=' + encodeURIComponent(id)) : null;
    $('task-detail-label').textContent = detail?.task.short_id ? '任务详情 · ' + detail.task.short_id : '任务详情';
    editing = id;
    baseline = detail ? detail.seq : state.seq;
    savedBaseline = baseline;
    pending = null;
    dirty = false;
    $('close').textContent = '关闭';
    form.reset();
    const workspace = detail ? workspaceOf(detail.task.data.context) : $('workspace').value;
    draftKey='lumos.task-draft.v1.'+(id || 'new.'+workspace);
    setTaskWorkspace(workspace, detail?.task.data.context);
    const data = detail?.task.data || {context: form.elements.namedItem('context').value,
      group: $('group-filter').value.startsWith(':') ? $('group-filter').value.slice(1) : '',
      status: 'todo', priority: 'normal'};
    for (const k of fields) form.elements.namedItem(k).value = data[k] || (k === 'priority' ? 'normal' : '');
    form.elements.namedItem('owner').value = ownerName(data);
    savedValues = values();
    draftBasis = savedValues;
    renderTask({...data, ...savedValues, follow_up_pending: data.follow_up_pending});
    setEditMode(!id && state.writable);
    $('form-message').textContent = '';
    restoreTaskDraft();
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
  keepTaskDraft();
  $('editor').close();
  dirty = false;
}

function markDirty() {
  if (!editMode) return;
  dirty = true;
  pending = null;
  $('close').textContent = '关闭';
  keepTaskDraft();
}
form.addEventListener('input', markDirty);
form.addEventListener('change', markDirty);
form.onsubmit = async event => {
  event.preventDefault();
  await saveChanges(values());
};

async function saveChanges(changes, quick = false) {
  if (saving || completionChoice || !state.writable || (quick ? !editing || editMode : !editMode)) return;
  if (quick && changes.status === savedValues.status) return;
  if (quick && pending?.changes.status !== changes.status) pending = null;
  if (!pending && changes.status === 'done' && savedValues.status !== 'done') {
    const date = await chooseCompletionDate({...savedValues, ...changes});
    if (date === null) return;
    changes = {...changes, completed_on: date};
  }
  if (isClosed(savedValues)) {
    changes = {...changes};
    delete changes.follow_up;
  }
  if (changes.status && changes.status !== 'done' && 'completed_on' in changes) changes.completed_on = '';
  saving = true;
  for (const control of form.elements) control.disabled = true;
  $('form-message').textContent = '正在保存…';
  try {
    pending ||= {request_id: crypto.randomUUID().replaceAll('-', ''), expected_seq: baseline,
      changes, ...(editing ? {id: editing} : {})};
    keepTaskDraft();
    const result = await api('/api/tasks', {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Lumos-Token': state.token}, body: JSON.stringify(pending)});
    dirty = false;
    writeTaskDraft(null);
    $('editor').close();
    const loaded = await refresh();
    if (loaded) showSaveNotice(result.replayed ? '已确认上次保存成功。'
      : quick ? '状态已更新为“' + labels[changes.status] + '”。' : '任务已保存。');
    else $('message').textContent = '任务已保存，但看板刷新失败。请点击刷新读取最新记录。';
  } catch (e) {
    $('form-message').textContent = e.message + (quick
      ? '\n尚未确认状态保存成功。网络失败可再次点击同一状态重试；若记录发生变化，请关闭详情并刷新后核对。'
      : '\n输入已保留。若记录发生变化，请先复制你的修改，关闭详情并刷新后核对；网络失败可直接重试。');
  } finally {
    saving = false;
    for (const control of form.elements) control.disabled = false;
    setEditMode(editMode);
    renderList(filtered());
  }
}
$('editor').addEventListener('cancel', event => {event.preventDefault(); closeEditor();});
dismissOnBackdrop($('editor'), closeEditor);
for (const id of ['rename-dialog', 'completion-picker']) dismissOnBackdrop($(id));
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
  for (const k of fields) form.elements.namedItem(k).value = savedValues[k];
  dirty = false;
  writeTaskDraft(null);
  draftBasis = savedValues;
  baseline = savedBaseline;
  pending = null;
  $('form-message').textContent = '';
  $('close').textContent = '关闭';
  if (!editing) { $('editor').close(); return; }
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
for (const view of ['list', 'schedule']) $('view-' + view).onclick = () => {
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
$('rename-group').onclick = () => {
  const previous = $('group-filter').value.slice(1), workspace = $('workspace').value;
  const tasks = state.tasks.filter(t => workspaceOf(t.data.context) === workspace && t.data.group === previous);
  if (!previous || !tasks.length || opening || saving || quickPending) return;
  const dialog = $('rename-dialog'), input = $('rename-name'), error = $('rename-error');
  const seq = state.seq;
  $('rename-impact').textContent = '将同步更新「' + previous + '」下的 ' + tasks.length + ' 项任务。';
  input.value = previous;
  error.textContent = '';
  input.setAttribute('aria-invalid', 'false');
  input.oninput = () => {
    error.textContent = '';
    input.setAttribute('aria-invalid', 'false');
  };
  $('rename-form').onsubmit = event => {
    event.preventDefault();
    const name = input.value.trim();
    if (name === previous) { dialog.close(); return; }
    if (!name || [...name].length > 80 || /[\r\n\t]/.test(name)) {
      error.textContent = '请输入 1 至 80 个字的单行名称。';
    } else if (groupNames(workspace).includes(name)) {
      error.textContent = '此名称已被使用，请换一个名称。';
    } else if (state.seq !== seq) {
      error.textContent = '任务已更新，请取消后重新打开。';
    } else {
      dialog.close();
      return quickSave(tasks[0].id, {group: name}, null, previous);
    }
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  };
  dialog.showModal();
  input.select();
};
$('rename-cancel').onclick = () => $('rename-dialog').close();
form.elements.namedItem('workspace').onchange = () => {
  if (!editMode || saving) return;
  setTaskWorkspace(form.elements.namedItem('workspace').value);
  form.elements.namedItem('group').value = '';
  markDirty();
};
$('owner-filter').onchange = render;
$('search').oninput = () => {if (state) render();};
window.addEventListener('beforeunload', event => {if (volatileDrafts.size || saving) {event.preventDefault(); event.returnValue = '';}});
restorePreferences();
refresh().then(() => {
  const params = new URLSearchParams(window.location?.search || '');
  const back = params.get('return');
  if (back && /^\/(?:delivery)?(?:\?(?:view=delivery(?:&line=[A-Za-z0-9_-]+)?|line=[A-Za-z0-9_-]+))?$/.test(back)) {
    $('back-mainline').href = back;
    $('back-mainline').hidden = false;
  }
  const id = params.get('task');
  if (id && state) openTask(id);
});
