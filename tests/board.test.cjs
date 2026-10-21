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
  const names = ['text', 'context', 'status', 'condition', 'details', 'next_step', 'progress', 'due', 'follow_up', 'priority'];
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
