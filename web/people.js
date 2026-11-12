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
  row.append(link, element('span', ownerName(task) + ' · ' + statuses[task.data.status] + ' · ' + (['done', 'cancelled'].includes(task.data.status) ? '不再提醒' : task.data.follow_up || '未设关心时间')));
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
function personLabel(person) {
  return person.title + (person.membership_status === 'candidate' ? '（候选 · 未入职）' : person.member_type === 'agent' ? '（Agent）' : '');
}
function chartMembers(members) {
  const list = element('ul', undefined, 'org-members');
  for (const person of members) {
    const item = element('li', undefined, person.membership_status === 'candidate' ? 'org-candidate' : '');
    const name = element('div', undefined, 'org-person-line');
    name.append(element('span', person.title, 'org-person'));
    if (person.org_role) name.append(element('span', person.org_role, 'org-role'));
    item.append(name);
    if (person.membership_status === 'candidate') item.append(element('small', '尚未入职', 'candidate-note'));
    if (person.team_status === 'proposed') item.append(element('small', '构思中 · 分组未定'));
    if (person.org_note) item.append(element('small', person.org_note, 'org-person-note'));
    if (person.arrival_note) item.append(element('small', person.arrival_note, 'candidate-note'));
    list.append(item);
  }
  if (!members.length) list.append(element('li', '人员待定', 'muted'));
  return list;
}
function renderOrganization(workspace, people) {
  const chart = state.contexts.find(c => workspaceOf(c.id) === workspace && c.data.org_chart)?.data.org_chart;
  const host = $('organization'); host.replaceChildren(); host.hidden = !chart;
  $('print-chart').hidden = !chart;
  if (!chart) return;
  people = people.filter(p => !(chart.hidden_people || []).includes(p.title));
  const heading = element('div', undefined, 'org-heading');
  heading.append(element('h2', chart.title + ' · 组织架构'), element('span', chart.caption || '组织架构', 'org-caption'));
  const root = element('div', undefined, 'org-root');
  root.append(element('h3', chart.title));
  if (chart.lead_team) root.append(chartMembers(people.filter(p => p.team === chart.lead_team)));
  const branches = element('div', undefined, 'org-branches');
  const assigned = new Set(chart.lead_team ? [chart.lead_team] : []);
  for (const branch of chart.branches) {
    const column = element('section', undefined, 'org-branch' + (branch.direct ? ' org-direct' : ''));
    const title = element('div', undefined, 'org-branch-title');
    if (branch.direct) title.setAttribute('aria-hidden', 'true');
    else title.append(element('h3', branch.title), element('p', branch.lead_label));
    column.append(title);
    const teams = element('div', undefined, 'org-teams');
    for (const team of branch.teams) {
      assigned.add(team);
      const group = element('section', undefined, 'org-team');
      const detail = chart.team_details?.[team];
      if (branch.direct || branch.teams.length !== 1 || team !== branch.title) {
        group.append(element('h4', team));
        const lead = detail?.lead_label || '';
        if (lead) group.append(element('p', lead, 'org-vacancy'));
      }
      group.append(chartMembers(people.filter(p => p.team === team)));
      if (detail) group.append(element('p', detail.plan, 'org-plan'));
      teams.append(group);
    }
    column.append(teams); branches.append(column);
  }
  const notes = element('ul', undefined, 'org-notes');
  for (const note of chart.notes) notes.append(element('li', note));
  host.append(heading, root, branches, notes);
  const other = people.filter(p => !assigned.has(p.team));
  if (other.length) {
    const aside = element('div', undefined, 'org-other');
    aside.append(element('h3', '部门直属角色'));
    for (const team of new Set(other.map(p => p.team || '其他人员'))) {
      const row = element('div'); row.append(element('h4', team), chartMembers(other.filter(p => (p.team || '其他人员') === team)));
      aside.append(row);
    }
    host.append(aside);
  }
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
  renderOrganization(workspace, people);
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
    const candidates = members.filter(p => p.membership_status === 'candidate').length;
    const total = candidates ? (members.length - candidates) + ' 位成员 + ' + candidates + ' 位候选' : members.length + ' 位';
    section.append(workloadRow('div', '全组 · ' + total, tasks.filter(t => members.some(p => ownerNames(t).includes(p.title)))));
    for (const person of members) {
      const owned = tasks.filter(t => ownerNames(t).includes(person.title)), details = element('details', undefined, 'member' + (person.membership_status === 'candidate' ? ' member-candidate' : ''));
      details.append(workloadRow('summary', personLabel(person), owned));
      const body = element('div', undefined, 'member-body');
      if (person.role) body.append(element('p', person.role, 'muted'));
      if (person.arrival_note) body.append(element('p', person.arrival_note, 'muted'));
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
$('print-chart').onclick = () => window.print();
refresh();
