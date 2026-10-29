const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Minimal DOM for the editor lifecycle; actual layout is checked in the browser.
class Element {
  constructor() { this.value = ''; this.disabled = false; this.open = false; this.children = []; this.events = {}; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  reset() { for (const control of this.elements) control.value = ''; }
}
const textOf = node => [node.textContent || '', ...(node.children || []).map(textOf)].join('\n');
const response = data => ({ok: true, json: async () => data});
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

async function page(storage = new Map(), initialBoard = {}) {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const names = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'follow_up', 'priority', 'owner', 'group', 'workspace'];
  const controls = Object.fromEntries(names.map(n => [n, new Element()]));
  const form = get('form');
  form.elements = [...Object.values(controls), get('save'), get('close')];
  form.elements.namedItem = name => controls[name];
  get('workspace').value = 'lingguang';
  const board = {seq: 3, today: '2026-10-21', writable: true, tasks: [], token: 'test-token',
    contexts: [{id: 'work-current', data: {title: '模拟工作'}}], integrity: {drafts_or_missing_working_copies: []}};
  Object.assign(board, initialBoard);
  const world = {document: {getElementById: get, createElement: () => new Element()},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
    window: {addEventListener() {}}, URLSearchParams, Option: function(text, value) { this.text = text; this.value = value; },
    crypto: {randomUUID: () => '11111111-1111-1111-1111-111111111111'},
    fetch: async () => response(board)};
  vm.createContext(world);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/board.js'), 'utf8'), world);
  await tick();
  return {world, get, controls, form, board};
}

test('saving locks fields, close and duplicate submission until the request settles', async () => {
  const p = await page();
  await p.world.openTask();
  p.controls.text.value = '模拟待办';
  p.form.events.input();
  const delayed = deferred();
  let writes = 0;
  p.world.fetch = (url, options) => {
    if (options?.method === 'POST') { writes++; return delayed.promise; }
    return Promise.resolve(response(p.board));
  };
  const saving = p.form.onsubmit({preventDefault() {}});
  assert.ok(p.form.elements.every(c => c.disabled));
  p.world.closeEditor();
  assert.equal(p.get('editor').open, true);
  await p.form.onsubmit({preventDefault() {}});
  assert.equal(writes, 1);
  delayed.resolve(response({replayed: false}));
  await saving;
  assert.equal(p.get('editor').open, false);
  assert.ok(p.form.elements.every(c => !c.disabled));
  assert.equal(p.get('message').textContent, '任务已保存。');
});

test('failed save retains input and retry uses the identical request id', async () => {
  const p = await page();
  await p.world.openTask();
  p.controls.text.value = '保留我的输入';
  p.form.events.input();
  const bodies = [];
  p.world.fetch = async (url, options) => {
    if (!options) return response(p.board);
    bodies.push(options.body);
    if (bodies.length === 1) throw new Error('response lost');
    return response({replayed: true});
  };
  await p.form.onsubmit({preventDefault() {}});
  assert.equal(p.get('editor').open, true);
  assert.equal(p.controls.text.value, '保留我的输入');
  assert.ok(p.form.elements.every(c => !c.disabled));
  await p.form.onsubmit({preventDefault() {}});
  assert.equal(bodies[0], bodies[1]);
  assert.equal(p.get('message').textContent, '已确认上次保存成功。');
});

test('successful save followed by failed refresh reports both states', async () => {
  const p = await page();
  await p.world.openTask();
  p.world.fetch = async (url, options) => {
    if (options) return response({});
    throw new Error('offline');
  };
  await p.form.onsubmit({preventDefault() {}});
  assert.match(p.get('message').textContent, /任务已保存，但看板刷新失败/);
});

test('continuing to edit resets the discard confirmation', async () => {
  const p = await page();
  await p.world.openTask();
  p.form.events.input();
  p.world.closeEditor();
  assert.equal(p.get('editor').open, true);
  p.form.events.input();
  p.world.closeEditor();
  assert.equal(p.get('editor').open, true);
  p.world.closeEditor();
  assert.equal(p.get('editor').open, false);
});

test('old tasks default to normal priority and detail requests cannot overlap', async () => {
  const p = await page();
  const delayed = deferred();
  let reads = 0;
  p.world.fetch = () => { reads++; return delayed.promise; };
  const loading = p.world.openTask('old-task');
  await p.world.openTask('other-task');
  assert.equal(reads, 1);
  delayed.resolve(response({seq: 3, task: {data: {text: '旧任务', context: 'work-current', status: 'todo',
    source: {ref: 'fixture'}}}, related: [], documents: {}, history: []}));
  await loading;
  assert.equal(p.controls.priority.value, 'normal');
  assert.equal(p.controls.text.value, '旧任务');
});

async function existingTask(p) {
  p.world.fetch = async () => response({seq: 3, task: {data: {text: '已记录的任务', context: 'work-current',
    status: 'doing', next_step: '第一行\n第二行', details: '<script>不执行</script>', source: {ref: 'fixture'}}},
    related: [], documents: {}, history: []});
  await p.world.openTask('existing');
}

test('recorded tasks open read-only, edit is explicit, cancel restores saved content', async () => {
  const p = await page();
  await existingTask(p);
  assert.equal(p.get('task-view').hidden, false);
  assert.equal(p.get('task-fields').hidden, true);
  assert.ok(Object.values(p.controls).every(c => c.disabled));
  assert.equal(p.get('edit-actions').hidden, true);
  assert.equal(p.get('editor-title').textContent, '已记录的任务');
  assert.equal(p.get('task-view').children.find(c => c.className === 'task-section').children[1].textContent, '第一行\n第二行');
  let writes = 0;
  p.world.fetch = async () => { writes++; return response({}); };
  await p.form.onsubmit({preventDefault() {}});
  assert.equal(writes, 0);
  p.get('edit').onclick();
  assert.equal(p.get('task-fields').hidden, false);
  assert.ok(Object.values(p.controls).every(c => !c.disabled));
  p.controls.text.value = '未保存修改';
  p.form.events.input();
  p.get('cancel-edit').onclick();
  assert.equal(p.controls.text.value, '已记录的任务');
  assert.equal(p.get('task-fields').hidden, true);
  p.world.closeEditor();
  assert.equal(p.get('editor').open, false);
  assert.equal(writes, 0);
});

test('read-only storage cannot enter editing or submit', async () => {
  const p = await page();
  p.board.writable = false;
  await existingTask(p);
  assert.equal(p.get('edit').disabled, true);
  p.get('edit').onclick();
  assert.equal(p.get('task-fields').disabled, true);
  p.world.fetch = async () => { throw new Error('must not write'); };
  await p.form.onsubmit({preventDefault() {}});
  assert.equal(p.get('form-message').textContent, '');
});

test('owner filtering composes with group and search, and survives refresh', async () => {
  const p = await page();
  p.board.tasks = [
    {id: 'mine', data: {text: '模拟地图', context: 'work-current', group: '地图', status: 'todo'}, attention: []},
    {id: 'other', data: {text: '模拟地图', context: 'work-current', group: '地图', owner: '同事', status: 'doing'}, attention: []},
    {id: 'elsewhere', data: {text: '模拟地图', context: 'other-context', owner: '同事', status: 'todo'}, attention: []}
  ];
  await p.world.refresh();
  p.get('owner-filter').value = 'Mango';
  assert.deepEqual(Array.from(p.world.filtered(), t => t.id), ['mine']);
  p.get('owner-filter').value = '同事';
  p.get('group-filter').value = ':地图';
  p.get('search').value = '地图';
  assert.deepEqual(Array.from(p.world.filtered(), t => t.id), ['other']);
  await p.world.refresh();
  assert.equal(p.get('owner-filter').value, '同事');
  p.get('search').value = '不存在';
  assert.equal(p.world.filtered().length, 0);
});

test('new tasks default to Mango and medium, and priorities have distinct text and color classes', async () => {
  const p = await page();
  await p.world.openTask();
  assert.equal(p.controls.owner.value, 'Mango');
  assert.equal(p.controls.priority.value, 'normal');
  const badges = ['low', 'normal', 'high'].map(priority => p.world.priorityTag({priority}));
  assert.deepEqual(badges.map(b => b.textContent), ['低优先级', '中优先级', '高优先级']);
  assert.equal(new Set(badges.map(b => b.className)).size, 3);
});

test('quick status saves only status, prevents duplicate writes and refreshes the board', async () => {
  const p = await page();
  await existingTask(p);
  assert.equal(p.get('quick-status').hidden, false);
  const buttons = p.get('status-buttons').children;
  assert.equal(buttons.find(b => b.value === 'doing').disabled, true);
  const delayed = deferred();
  const requests = [];
  p.world.fetch = (url, options) => {
    if (!options) return Promise.resolve(response(p.board));
    requests.push(JSON.parse(options.body));
    return delayed.promise;
  };
  const done = buttons.find(b => b.value === 'done');
  const saving = done.onclick();
  p.get('edit').onclick();
  p.world.closeEditor();
  await done.onclick();
  assert.equal(p.get('editor').open, true);
  assert.equal(p.get('task-fields').hidden, true);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].changes, {status: 'done'});
  assert.equal(requests[0].id, 'existing');
  assert.equal(requests[0].expected_seq, 3);
  delayed.resolve(response({seq: 4}));
  await saving;
  assert.equal(p.get('editor').open, false);
  assert.equal(p.get('message').textContent, '状态已更新为“已完成”。');
});

test('quick status failure preserves original status and retries the identical request', async () => {
  const p = await page();
  await existingTask(p);
  const bodies = [];
  p.world.fetch = async (url, options) => {
    if (!options) return response(p.board);
    bodies.push(options.body);
    if (bodies.length === 1) throw new Error('offline');
    return response({replayed: true});
  };
  await p.world.saveChanges({status: 'blocked'}, true);
  assert.equal(p.get('editor').open, true);
  assert.equal(p.controls.status.value, 'doing');
  assert.match(p.get('form-message').textContent, /尚未确认状态保存成功/);
  await p.world.saveChanges({status: 'blocked'}, true);
  assert.equal(bodies[0], bodies[1]);
});

test('quick status respects read-only mode and does not submit an unchanged status', async () => {
  const p = await page();
  await existingTask(p);
  p.world.fetch = async () => { assert.fail('must not write'); };
  await p.world.saveChanges({status: 'doing'}, true);
  p.board.writable = false;
  p.world.setEditMode(false);
  assert.ok(p.get('status-buttons').children.every(b => b.disabled));
  await p.world.saveChanges({status: 'done'}, true);
});

test('board moves persist status and position, retry identically and block concurrent writes', async () => {
  const p = await page();
  p.board.tasks = [
    {id: 'a', data: {text: 'A', status: 'todo'}, attention: []},
    {id: 'b', data: {text: 'B', status: 'todo'}, attention: []},
    {id: 'c', data: {text: 'C', status: 'cancelled'}, attention: []}
  ];
  p.board.board_order = ['b', 'a', 'c'];
  assert.deepEqual(Array.from(p.world.columnTasks(p.board.tasks, 'todo'), t => t.id), ['b', 'a']);
  const bodies = [];
  p.world.fetch = async (url, options) => {
    if (!options) return response(p.board);
    bodies.push(options.body);
    if (bodies.length === 1) throw new Error('offline');
    return response({});
  };
  await p.world.moveTask('a', 'todo', 'b');
  assert.match(p.get('message').textContent, /尚未确认保存成功/);
  await p.world.moveTask('a', 'todo', 'b');
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[0]).changes, {status: 'todo'});
  assert.equal(JSON.parse(bodies[0]).before_id, 'b');
  await p.world.moveTask('c', 'done');
  assert.deepEqual(JSON.parse(bodies[2]).changes, {status: 'cancelled'});
  const delayed = deferred();
  p.world.fetch = (url, options) => {
    if (!options) return Promise.resolve(response(p.board));
    bodies.push(options.body);
    return delayed.promise;
  };
  const moving = p.world.moveTask('a', 'doing');
  await p.world.moveTask('b', 'doing');
  assert.equal(bodies.length, 4);
  delayed.resolve(response({}));
  await moving;
  p.board.writable = false;
  await p.world.moveTask('a', 'done');
  assert.equal(bodies.length, 4);
});

test('workspaces default to Lingguang, groups span contexts and switching clears filters', async () => {
  const p = await page();
  p.board.contexts.push({id:'lidar', data:{title:'雷达背景', workspace:'lingguang'}},
    {id:'lumos-maintenance', data:{title:'维护', workspace:'lumos'}});
  p.board.tasks = [
    {id:'a',data:{text:'A',context:'work-current',group:'感知',status:'todo'},attention:[]},
    {id:'b',data:{text:'B',context:'lidar',group:'感知',status:'doing'},attention:[]},
    {id:'c',data:{text:'C',context:'work-current',status:'todo'},attention:[]},
    {id:'d',data:{text:'D',context:'lumos-maintenance',group:'感知',status:'todo'},attention:[]}
  ];
  await p.world.refresh();
  assert.equal(p.get('workspace').value,'lingguang');
  assert.equal(p.get('group-filter').value,'');
  assert.deepEqual(Array.from(p.world.filtered(),t=>t.id),['a','b','c']);
  p.get('group-filter').value=':感知';
  assert.deepEqual(Array.from(p.world.filtered(),t=>t.id),['a','b']);
  await p.world.openTask();
  assert.equal(p.controls.context.value,'work-current');
  assert.equal(p.controls.group.value,'感知');
  p.world.closeEditor();
  p.get('group-filter').value='-';
  assert.deepEqual(Array.from(p.world.filtered(),t=>t.id),['c']);
  p.get('workspace').value='lumos';
  p.get('workspace').onchange();
  assert.equal(p.get('group-filter').value,'');
  assert.deepEqual(Array.from(p.world.filtered(),t=>t.id),['d']);
  await p.world.openTask();
  assert.equal(p.controls.context.value,'lumos-maintenance');
  assert.equal(p.controls.workspace.value,'lumos');
  p.world.closeEditor();
  await p.world.refresh();
  assert.equal(p.get('workspace').value,'lumos');
});

test('custom group save retains context and cancel restores workspace and group', async () => {
  const p = await page();
  p.board.contexts.push({id:'lumos-maintenance',data:{title:'维护',workspace:'lumos'}});
  await existingTask(p);
  p.get('edit').onclick();
  p.controls.group.value='新分组';
  p.controls.workspace.value='lumos';
  p.controls.workspace.onchange();
  assert.equal(p.controls.context.value,'lumos-maintenance');
  assert.equal(p.controls.group.value,'');
  p.get('cancel-edit').onclick();
  assert.equal(p.controls.context.value,'work-current');
  assert.equal(p.controls.workspace.value,'lingguang');
  p.get('edit').onclick();
  p.controls.group.value='新分组';
  let saved;
  p.world.fetch=async (url,options)=>{
    if(!options) return response(p.board);
    saved=JSON.parse(options.body); return response({});
  };
  await p.form.onsubmit({preventDefault(){}});
  assert.equal(saved.changes.group,'新分组');
  assert.equal(saved.changes.context,'work-current');
  assert.equal('workspace' in saved.changes,false);
});

test('detail separates folded background and sources, formats documents safely and labels superseded advice', async () => {
  const p = await page();
  const payload = '<img src=x onerror=alert(1)>';
  p.world.renderHistory({task: {data: {source: {type:'user',ref:'创建依据',quote:'原话'}}},
    documents: {note:'# 专项结论\n\n## 已明确\n- ' + payload},
    document_info: {note:{title:'专项结论',relation:'direct',context_title:'专项讨论',context_status:'active'}},
    related:[{id:'old',kind:'evidence',data:{text:'旧方案',status:'superseded',source:{type:'agent',ref:'旧建议'}}}], history:[]});
  const groups = p.get('history').children;
  assert.equal(groups.length, 3);
  assert.ok(groups.every(g => !g.open));
  assert.match(textOf(groups[0]), /直接关联 · 专项结论/);
  assert.match(textOf(groups[0]), /已被替代，仅供追溯/);
  assert.match(textOf(groups[1]), /用户陈述：创建依据\n原话：原话/);
  const walk = node => [node, ...node.children.flatMap(walk)];
  assert.ok(walk(groups[0]).some(n => n.textContent === payload));
  assert.ok(walk(groups[0]).every(n => n.innerHTML === undefined));
  assert.ok(groups[0].children.filter(n => n.children.length).every(n => !n.open));
});

test('history shows only changed fields, including cleared dates, state and completion, and can reopen cleanly', async () => {
  const p = await page();
  const before = {text:'不应重复的标题',details:'不应重复的正文',status:'doing',follow_up:'2026-10-24',source:{ref:'原始'}};
  const after = {...before,status:'done',follow_up:'',completion:{basis:'user_report',ref:'用户说完成'},last_source:{type:'user',ref:'本次修改'}};
  const detail = {task:{data:after},documents:{},related:[],history:[{at:'2026-10-24T00:00:00Z',reason:'核对修改',before:{data:before},after:{data:after}}]};
  p.world.renderHistory(detail);
  const history = p.get('history').children[2];
  assert.doesNotMatch(textOf(history), /不应重复/);
  assert.match(textOf(history), /原：进行中/);
  assert.match(textOf(history), /现：已完成/);
  assert.match(textOf(history), /原：2026-10-24/);
  assert.match(textOf(history), /现：未设置/);
  assert.match(textOf(history), /用户报告完成/);
  assert.match(textOf(history), /修改原因：核对修改/);
  history.open = true;
  p.world.renderHistory(detail);
  assert.equal(p.get('history').children[2].open, false);
});

test('status filters default to todo and doing, compose as toggles and apply to board', async () => {
  const p = await page();
  p.board.tasks = ['todo','doing','blocked','done','cancelled'].map((status, i) => ({id: String(i),
    data: {text: status, status, context: 'work-current', group: '项目甲'}, attention: status === 'blocked' ? ['受阻'] : []}));
  await p.world.refresh();
  assert.equal(p.get('board').hidden, true);
  assert.equal(p.get('task-list').children.length, 3);
  assert.equal(p.get('task-list').children[1].children[2].textContent, '项目甲');
  assert.equal(p.get('task-list').children[1].children[3].textContent, 'Mango');
  p.get('status-todo').onclick();
  p.get('status-doing').onclick();
  p.get('status-done').onclick();
  assert.equal(p.get('task-list').children.length, 2);
  assert.deepEqual(Array.from(p.world.filtered(), t => t.id), ['3']);
  p.get('status-cancelled').onclick();
  assert.deepEqual(Array.from(p.world.filtered(), t => t.id), ['3', '4']);
  p.get('view-board').onclick();
  assert.equal(p.get('board').hidden, false);
  assert.equal(p.get('task-list').hidden, true);
  assert.equal(p.get('board').children.length, 4);
  await p.world.refresh();
  assert.deepEqual(Array.from(p.world.filtered(), t => t.id), ['3', '4']);
  p.get('status-done').onclick();
  p.get('status-cancelled').onclick();
  assert.equal(p.world.filtered().length, 0);
});

test('inline updates send one field, lock during save, retry identically and refresh after conflict', async () => {
  const p = await page();
  p.board.tasks = [{id:'a', data:{text:'模拟任务',status:'doing',context:'work-current'},attention:[]}];
  await p.world.refresh();
  const writes = [], delayed = deferred();
  p.world.fetch = async (url, options) => {
    if (!options) return response(p.board);
    writes.push(options.body);
    if (writes.length === 1) return delayed.promise;
    return response({});
  };
  const operation = p.world.quickSave('a', {priority:'high'});
  assert.equal(p.get('task-list').children[1].children[1].disabled, true);
  await p.world.quickSave('a', {follow_up:'2026-11-01'});
  assert.equal(writes.length, 1);
  delayed.resolve({ok:false,json:async()=>({error:'version conflict'})});
  await operation;
  assert.equal(p.get('quick-retry').hidden, false);
  await p.get('quick-retry').onclick();
  assert.equal(writes[0], writes[1]);
  assert.deepEqual(JSON.parse(writes[0]).changes, {priority:'high'});
  assert.equal(p.get('task-list').children[1].children[1].disabled, false);
  await p.world.quickSave('a', {follow_up:''});
  assert.deepEqual(JSON.parse(writes[2]).changes, {follow_up:''});
  p.world.fetch = async (url, options) => options ? {ok:false,json:async()=>({error:'version conflict'})} : response(p.board);
  await p.world.quickSave('a', {status:'done'});
  p.board.seq = 4;
  await p.get('refresh').onclick();
  assert.equal(p.get('quick-retry').hidden, true);
  assert.equal(p.get('task-list').children[1].children[1].disabled, false);
  p.board.writable = false;
  await p.world.refresh();
  assert.equal(p.get('task-list').children[1].children[5].children[0].disabled, true);
});

test('time window uses server Shanghai date, includes overdue and undated open tasks, composes with status', async () => {
  const p = await page();
  p.board.today = '2026-10-29';
  const cases = [['past','todo','2026-10-28'],['today','doing','2026-10-29'],
    ['edge','doing','2026-11-03'],['later','todo','2026-11-04'],['undated','todo',''],
    ['doing-empty','doing',''],['blocked','blocked','2026-11-01']];
  p.board.tasks = cases.map(([id,status,follow_up]) => ({id,data:{text:id,status,follow_up,context:'work-current'},attention:[]}));
  await p.world.refresh();
  const ids = () => Array.from(p.world.filtered(), t => t.id);
  assert.equal(ids().length, 6);
  p.get('window-days').value = '5'; p.get('window-days').oninput();
  assert.deepEqual(ids(), ['past','today','edge','undated','doing-empty']);
  p.get('status-blocked').onclick();
  assert.deepEqual(ids(), ['past','today','edge','undated','doing-empty','blocked']);
  p.get('window-days').value = '-1'; p.get('window-days').oninput();
  assert.deepEqual(ids(), ['past','today','edge','undated','doing-empty','blocked']);
  p.get('window-days').value = '0'; p.get('window-days').oninput();
  assert.deepEqual(ids(), ['past','today','undated','doing-empty']);
  p.get('owner-filter').value = 'other';
  assert.deepEqual(ids(), []);
  p.get('owner-filter').value = '';
  p.get('clear-window').onclick();
  assert.equal(ids().length, 7);
});

test('all list columns sort without writes; date blanks stay last and third click restores order', async () => {
  const p = await page();
  p.board.tasks = [
    {id:'a',data:{text:'A',owner:'Z',priority:'low',group:'Z',status:'doing',follow_up:'2026-11-01',context:'work-current'},attention:[]},
    {id:'b',data:{text:'B',owner:'A',priority:'high',group:'A',status:'todo',follow_up:'2026-10-30',context:'work-current'},attention:[]},
    {id:'c',data:{text:'C',status:'todo',context:'work-current'},attention:[]}
  ];
  p.board.board_order = ['a','b','c'];
  await p.world.refresh();
  p.world.fetch = () => { throw new Error('sorting must not request or write'); };
  const ids = () => p.get('task-list').children.slice(1).map(row => row.dataset.id);
  const click = i => p.get('task-list').children[0].children[i].onclick();
  click(5); assert.deepEqual(ids(), ['b','a','c']);
  click(5); assert.deepEqual(ids(), ['a','b','c']);
  click(5); assert.deepEqual(ids(), ['a','b','c']);
  click(1); assert.deepEqual(ids(), ['b','c','a']);
  click(3); assert.deepEqual(ids(), ['b','c','a']);
  click(2); assert.deepEqual(ids(), ['c','b','a']);
  click(4); assert.deepEqual(ids(), ['b','c','a']);
  click(0); assert.deepEqual(ids(), ['a','b','c']);
  click(0); assert.deepEqual(ids(), ['c','b','a']);
  assert.deepEqual(p.board.board_order, ['a','b','c']);
  assert.deepEqual(p.board.tasks.map(t => t.id), ['a','b','c']);
});

test('preferences survive reopening with filters, sort and view, including an empty status selection', async () => {
  const storage = new Map();
  const initial = {contexts:[{id:'lumos-maintenance',data:{title:'维护',workspace:'lumos'}}],
    tasks:[{id:'a',data:{context:'lumos-maintenance',text:'维护任务',status:'todo',owner:'同事',group:'界面'},attention:[]}]};
  const p = await page(storage, initial);
  p.get('workspace').value = 'lumos'; p.get('workspace').onchange();
  p.get('group-filter').value = ':界面'; p.get('group-filter').onchange();
  p.get('owner-filter').value = '同事'; p.get('owner-filter').onchange();
  p.get('search').value = '维护'; p.get('search').oninput();
  p.get('window-days').value = '5'; p.get('window-days').oninput();
  p.get('status-blocked').onclick();
  p.get('task-list').children[0].children[5].onclick();
  p.get('task-list').children[0].children[5].onclick();
  p.get('view-board').onclick();
  const before = storage.get('lumos.task-view.v1');
  const q = await page(storage, initial);
  assert.equal(storage.get('lumos.task-view.v1'), before);
  assert.equal(q.get('workspace').value, 'lumos');
  assert.equal(q.get('group-filter').value, ':界面');
  assert.equal(q.get('owner-filter').value, '同事');
  assert.equal(q.get('search').value, '维护');
  assert.equal(q.get('window-days').value, '5');
  assert.equal(q.get('status-blocked')['aria-pressed'], 'true');
  assert.equal(q.get('view-board')['aria-pressed'], 'true');
  assert.equal(q.get('board').hidden, false);
  assert.match(q.get('task-list').children[0].children[5].textContent, /↓/);
  for (const s of ['todo','doing','blocked']) q.get('status-' + s).onclick();
  const r = await page(storage, initial);
  assert.equal(r.world.filtered().length, 0);
  assert.match(textOf(r.get('task-list')), /尚未选择状态/);
});

test('blocked remains selectable with zero tasks and storage failures do not break filtering', async () => {
  const p = await page();
  assert.equal(p.get('status-blocked').disabled, false);
  p.get('status-todo').onclick(); p.get('status-doing').onclick(); p.get('status-blocked').onclick();
  assert.equal(p.get('status-blocked')['aria-pressed'], 'true');
  assert.match(textOf(p.get('task-list')), /已筛选：受阻/);
  p.world.localStorage.setItem = () => {throw new Error('storage disabled');};
  p.get('status-blocked').onclick();
  assert.match(p.get('preferences-message').textContent, /未允许保存偏好/);
  assert.match(textOf(p.get('task-list')), /尚未选择状态/);
  const storage = new Map([['lumos.task-view.v1','{bad json']]);
  const q = await page(storage);
  assert.equal(q.get('status-todo')['aria-pressed'], 'true');
  assert.equal(q.get('status-doing')['aria-pressed'], 'true');
  storage.set('lumos.task-view.v1', JSON.stringify({statuses:['invalid'],sortKey:'invalid',windowDays:-1,workspace:'bad'}));
  const r = await page(storage);
  assert.equal(r.get('workspace').value, 'lingguang');
  assert.equal(r.get('window-days').value, '');
  assert.equal(r.get('status-todo')['aria-pressed'], 'true');
});

test('follow-up colors use Shanghai day and pending open tasks remain in the time window', async () => {
  const p = await page();
  p.board.today = '2026-03-01';
  assert.equal(p.world.followUpHint({status:'doing',follow_up:'2026-02-27'}).text, '已过 2 天');
  assert.equal(p.world.followUpHint({status:'todo',follow_up:'2026-03-01'}).cls, 'follow-up-today');
  assert.equal(p.world.followUpHint({status:'done',follow_up:'2026-02-27'}).text, '');
  assert.equal(p.world.followUpHint({status:'cancelled',follow_up_pending:true}).text, '');
  for (const status of ['todo','doing','blocked','done','cancelled']) {
    for (const legacy of [{}, {follow_up_pending:false}, {follow_up_pending:true}]) {
      const hint = p.world.followUpHint({status, ...legacy});
      assert.equal(hint.cls, ['done','cancelled'].includes(status) ? '' : 'follow-up-pending');
    }
  }
  p.board.tasks = ['doing','blocked'].map(status => ({id:status,data:{text:status,context:'work-current',status,follow_up:''},attention:['待设置关心时间']}));
  await p.world.refresh();
  p.get('window-days').value='0'; p.get('window-days').oninput();
  assert.deepEqual(Array.from(p.world.filtered(), t=>t.id), ['doing']);
  p.get('status-blocked').onclick();
  assert.deepEqual(Array.from(p.world.filtered(), t=>t.id), ['doing','blocked']);
  assert.match(textOf(p.get('task-list')), /待设置关心时间/);
  assert.match(textOf(p.get('board')), /待设置关心时间/);
  p.board.tasks[0].data.follow_up='2026-03-05'; p.board.tasks[0].data.follow_up_pending=false;
  assert.deepEqual(Array.from(p.world.filtered(), t=>t.id), ['blocked']);
  p.get('owner-filter').value='其他人';
  assert.equal(p.world.filtered().length,0);
});

test('roster includes people without tasks, grouped owners and workspace isolation', async () => {
  const people = [
    {id:'p1',data:{title:'模拟甲',team:'模拟平台组',team_status:'proposed',role:'<script>保留文字</script>',workspaces:['lingguang']}},
    {id:'p2',data:{title:'模拟乙',team:'模拟协作方',role:'不在管理范围',workspaces:['lingguang']}},
    {id:'p3',data:{title:'模拟维护者',team:'维护',member_type:'agent',workspaces:['lumos']}},
    {id:'p4',data:{title:'Mango',team:'本人',workspaces:['lingguang','lumos']}}
  ];
  const tasks = [{id:'t1',data:{text:'模拟任务',context:'work-current',owner:'模拟乙',status:'todo',group:'原标签'},attention:[]}];
  const p = await page(new Map(), {people,tasks,contexts:[{id:'work-current',data:{}},{id:'lumos-maintenance',data:{}}]});
  const options = p.world.ownerOptions('lingguang', '历史负责人', true);
  assert.equal(p.get('owner-filter').children[0].text, '全部负责人');
  assert.equal(p.get('owner-filter').children[1].value, 'Mango');
  assert.match(options[1].text, /构思中/);
  assert.equal(options[1].className, 'owner-team');
  assert.ok(!options.some(o=>o.text.includes('全组')));
  assert.ok(options.some(o=>o.value==='历史负责人'));
  p.get('owner-filter').value = '@team:模拟协作方';
  assert.equal(p.world.filtered().length, 1);
  await p.world.refresh();
  assert.equal(p.get('owner-filter').value, '@team:模拟协作方');
  p.get('owner-filter').value = '@team:模拟平台组（构思中 · 分组未定）';
  assert.equal(p.world.filtered().length, 0);
  assert.ok(!p.world.ownerOptions('lingguang').flatMap(g=>g.children || []).some(o=>o.value.startsWith('@team:')));
  await p.world.openTask();
  assert.equal(p.controls.owner.value, 'Mango');
  assert.ok(p.controls.owner.children.flatMap(g=>g.children || []).some(o=>o.value==='模拟甲'));
  p.world.closeEditor();
  p.get('workspace').value='lumos'; p.get('workspace').onchange();
  assert.ok(p.world.ownerOptions('lumos').flatMap(g=>g.children || []).some(o=>o.value==='模拟维护者'));
  assert.ok(!p.world.ownerOptions('lumos').flatMap(g=>g.children || []).some(o=>o.value==='模拟甲'));
  assert.equal(p.board.tasks[0].data.group, '原标签');
});

test('editing an owner absent from roster preserves it when cancelling', async () => {
  const p = await page();
  p.world.fetch=async()=>response({seq:3,task:{data:{text:'旧任务',context:'work-current',status:'doing',owner:'旧负责人',group:'原标签',source:{ref:'fixture'}}},related:[],documents:{},history:[]});
  await p.world.openTask('old');
  assert.ok(p.controls.owner.children.flatMap(g=>g.children || []).some(o=>o.value==='旧负责人'));
  p.get('edit').onclick(); p.controls.owner.value='Mango'; p.form.events.input();
  p.get('cancel-edit').onclick();
  assert.ok(p.controls.owner.children.flatMap(g=>g.children || []).some(o=>o.value==='旧负责人'));
  assert.equal(p.controls.owner.value, '旧负责人');
  assert.equal(p.controls.group.value, '原标签');
});

test('personnel periods include today as first or middle day and use Shanghai update dates', () => {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const world = {document:{getElementById:get,createElement:()=>new Element()}, fetch:()=>new Promise(()=>{})};
  vm.createContext(world);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../web/people.js'), 'utf8'),world);
  const task = (id,status,date,updated_at) => ({id,data:{status,follow_up:date,updated_at}});
  const tasks = [task('old','done','','2026-10-27T15:59:59Z'),task('edge','done','','2026-10-27T16:00:00Z'),
    task('today','doing','2026-10-29'),task('next','todo','2026-10-30'),task('last','todo','2026-10-31'),
    task('outside','todo','2026-11-01'),task('undated','blocked','')];
  assert.deepEqual(Array.from(world.periodRange('2026-10-29',3,'future')),['2026-10-29','2026-10-31']);
  assert.deepEqual(Array.from(world.periodRange('2026-10-29',3,'recent')),['2026-10-28','2026-10-30']);
  assert.deepEqual(Array.from(world.periodRange('2026-10-29',30,'recent')),['2026-10-15','2026-11-13']);
  assert.deepEqual(Array.from(world.periodTasks(tasks,'2026-10-29',3,'future'),t=>t.id),['today','next','last','undated']);
  assert.deepEqual(Array.from(world.periodTasks(tasks,'2026-10-29',3,'recent'),t=>t.id),['edge','today','next','undated']);
});

test('schedule is a third persistent view and composes with all task filters', async () => {
  const storage = new Map();
  const tasks = [
    {id:'a',data:{text:'选中任务',context:'work-current',owner:'Mango',group:'组',status:'doing',follow_up:'2026-10-21'},attention:[]},
    {id:'b',data:{text:'排除任务',context:'work-current',owner:'其他',group:'组',status:'doing'},attention:[]},
    {id:'c',data:{text:'排除完成',context:'work-current',owner:'Mango',group:'组',status:'done'},attention:[]}];
  const p = await page(storage,{tasks});
  p.get('owner-filter').value='Mango';p.get('group-filter').value=':组';p.get('view-schedule').onclick();
  assert.equal(p.get('schedule-list').hidden,false);assert.equal(p.get('task-list').hidden,true);assert.equal(p.get('board').hidden,true);
  assert.match(textOf(p.get('schedule-list')), /选中任务/);assert.doesNotMatch(textOf(p.get('schedule-list')), /排除/);
  const q = await page(storage,{tasks});assert.equal(q.get('view-schedule')['aria-pressed'],'true');
  q.get('search').value='无匹配';q.get('search').oninput();assert.match(textOf(q.get('schedule-list')), /当前筛选下暂无任务/);
});

test('filter changes before initial data arrives do not crash', async () => {
  const p = await page();
  vm.runInContext('state = undefined', p.world);
  assert.doesNotThrow(() => p.get('owner-filter').onchange());
  assert.doesNotThrow(() => p.get('workspace').onchange());
});
