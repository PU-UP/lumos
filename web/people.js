const $ = id => document.getElementById(id);
const statuses = {todo:'待开始', doing:'进行中', blocked:'受阻', done:'已完成'};
let state;
function element(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
const ownerName = task => task.data.owner?.trim() || '王牧楠';
const ownerNames = task => ownerName(task).split('、').map(name => name.trim()).filter(Boolean);
function workspaceOf(context) {
  return state.contexts.find(c => c.id === context)?.data.workspace || (context === 'lumos-maintenance' ? 'lumos' : 'lingguang');
}
function counts(tasks) { return Object.keys(statuses).map(status => tasks.filter(t => t.data.status === status).length); }
function taskRow(task) {
  const row = element('div', undefined, 'people-task'), link = element('a', task.data.text);
  link.href = '/?task=' + encodeURIComponent(task.id);
  row.append(link, element('span', ownerName(task) + ' · ' + statuses[task.data.status] + ' · ' + (task.data.follow_up || '未设关心时间')));
  return row;
}
function workloadRow(tag, name, tasks, cls = '') {
  const row = element(tag, undefined, 'workload-row ' + cls);
  const values = counts(tasks);
  row.append(element('span', name, 'person-title'), ...values.map(n => element('span', String(n))));
  if (tag === 'summary') row.setAttribute('aria-label', name + '，' + Object.values(statuses).map((s,i) => s + values[i] + '项').join('，'));
  return row;
}
function updatedDay(task) {
  const time = Date.parse(task.data.updated_at || '');
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0,10) : '';
}
function periodRange(today, days, mode) {
  const start = new Date(today + 'T00:00:00Z');
  if (mode === 'recent') start.setUTCDate(start.getUTCDate() - Math.floor((days - 1) / 2));
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + days - 1);
  return [start.toISOString().slice(0,10), end.toISOString().slice(0,10)];
}
function periodTasks(tasks, today, days, mode) {
  const [from, until] = periodRange(today, days, mode);
  return tasks.filter(task => {
    const open = !['done','cancelled'].includes(task.data.status), date = task.data.follow_up;
    const planned = open && date >= today && date <= until;
    if (mode === 'future') return planned || (open && !date);
    const updated = updatedDay(task);
    return planned || (updated >= from && updated <= today) || (open && !date);
  });
}
function render() {
  if (!state) return;
  const workspace = $('workspace').value;
  const allTasks = state.tasks.filter(t => workspaceOf(t.data.context) === workspace && t.data.status !== 'cancelled');
  const days = Number($('days').value), mode = $('period-mode').value;
  const tasks = periodTasks(allTasks, state.today, days, mode), [from, until] = periodRange(state.today, days, mode);
  $('period-hint').textContent = from + ' 至 ' + until + '（含首尾，共 ' + days + ' 天）。'
    + (mode === 'future' ? '今天为第1天，按下次关心时间统计未结束任务。' : '今天居中：统计前半段更新过的任务及今天起的关心安排，按当前状态计数；已完成不等于期间完成量。')
    + '未设关心时间的未结束任务也保留，避免遗漏。已取消不计，数量不代表工时。';
  const people = (state.people || []).filter(p => p.data.workspaces.includes(workspace)).map(p => p.data);
  const known = new Set(people.map(p => p.title));
  for (const task of allTasks) for (const name of ownerNames(task)) if (!known.has(name)) {
    known.add(name); people.push({title:name, team:'名册外负责人'});
  }
  const groups = new Map();
  for (const person of people) {
    const team = (person.team || '其他人员') + (person.team_status === 'proposed' ? '（构思中 · 分组未定）' : '');
    if (!groups.has(team)) groups.set(team, []);
    groups.get(team).push(person);
  }
  $('people-list').replaceChildren();
  for (const [team, members] of groups) {
    const section = element('section', undefined, 'people-team');
    section.append(element('h3', team));
    const head = element('div', undefined, 'workload-row workload-head');
    head.append(element('span', '成员'), ...Object.values(statuses).map(s => element('span', s))); section.append(head);
    section.append(workloadRow('div', '全组 · ' + members.length + ' 位', tasks.filter(t => members.some(p => ownerNames(t).includes(p.title)))));
    for (const person of members) {
      const owned = tasks.filter(t => ownerNames(t).includes(person.title)), details = element('details', undefined, 'member');
      details.append(workloadRow('summary', person.title + (person.member_type === 'agent' ? '（Agent）' : ''), owned));
      const body = element('div', undefined, 'member-body');
      if (person.role) body.append(element('p', person.role, 'muted'));
      body.append(...owned.map(taskRow));
      if (!owned.length) body.append(element('p', '暂无任务', 'muted'));
      details.append(body); section.append(details);
    }
    $('people-list').append(section);
  }
  if (!people.length) $('people-list').append(element('p', '尚未记录人员名册。', 'muted'));
}

async function refresh() {
  $('message').textContent = '正在读取…';
  try {
    const res = await fetch('/api/tasks'); const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取失败');
    state = data; render(); $('message').textContent = '';
  } catch (error) { $('message').textContent = '刷新失败：' + error.message + '。请重试；已有内容可能不是最新。'; }
}
$('workspace').onchange = render;
$('days').onchange = render;
$('period-mode').onchange = render;
$('refresh').onclick = refresh;
refresh();
