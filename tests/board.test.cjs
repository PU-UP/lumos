const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Minimal DOM for the editor lifecycle; actual layout is checked in the browser.
class Element {
  constructor() { this.value = ''; this.disabled = false; this.open = false; this.children = []; this.events = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, fn) { this.events[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  reset() { for (const control of this.elements) control.value = ''; }
}
const response = data => ({ok: true, json: async () => data});
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

async function page() {
  const nodes = new Map();
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const names = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'follow_up', 'priority', 'owner'];
  const controls = Object.fromEntries(names.map(n => [n, new Element()]));
  const form = get('form');
  form.elements = [...Object.values(controls), get('save'), get('close')];
  form.elements.namedItem = name => controls[name];
  const board = {seq: 3, today: '2026-10-21', writable: true, tasks: [], token: 'test-token',
    contexts: [{id: 'work-current', data: {title: '模拟工作'}}], integrity: {drafts_or_missing_working_copies: []}};
  const world = {document: {getElementById: get, createElement: () => new Element()},
    window: {addEventListener() {}}, Option: function(text, value) { this.text = text; this.value = value; },
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
  assert.equal(p.get('task-view').children[2].children[1].textContent, '第一行\n第二行');
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

test('owner filtering composes with context and search, and survives refresh', async () => {
  const p = await page();
  p.board.tasks = [
    {id: 'mine', data: {text: '模拟地图', context: 'work-current', status: 'todo'}, attention: []},
    {id: 'other', data: {text: '模拟地图', context: 'work-current', owner: '同事', status: 'doing'}, attention: []},
    {id: 'elsewhere', data: {text: '模拟地图', context: 'other-context', owner: '同事', status: 'todo'}, attention: []}
  ];
  await p.world.refresh();
  p.get('owner-filter').value = 'Mango';
  assert.deepEqual(Array.from(p.world.filtered(), t => t.id), ['mine']);
  p.get('owner-filter').value = '同事';
  p.get('context').value = 'work-current';
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
