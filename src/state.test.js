const test = require('node:test');
const assert = require('node:assert/strict');
const { Model, cloneData } = require('./state');

/** @typedef {import('./state').StateMessage} StateMessage */

/** Lets queued microtasks (the per-tick flush) run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A model with `state` registered and a subscriber collecting its messages (minus the initial snapshot).
 * @param {import('./state').StateObject} state
 */
function observed(state) {
  const model = new Model();
  model.replace(state);
  /** @type {StateMessage[]} */
  const messages = [];
  model.subscribe((message) => messages.push(message));
  messages.length = 0;
  return { model, state: /** @type {any} */ (model.state), messages };
}

test('a subscriber gets the current state at once, then one message per tick', async () => {
  const model = new Model();
  model.replace({ cwd: '/', panes: { left: { cursor: 0 } } });
  /** @type {StateMessage[]} */
  const messages = [];
  model.subscribe((message) => messages.push(message));
  assert.deepEqual(messages, [{ type: 'replace', state: { cwd: '/', panes: { left: { cursor: 0 } } } }]);

  const state = /** @type {any} */ (model.state);
  state.cwd = '/tmp';
  state.panes.left.cursor = 3;
  assert.equal(messages.length, 1, 'nothing is sent before the tick ends');
  await tick();
  assert.deepEqual(messages[1], {
    type: 'patch',
    patches: [
      { op: 'set', path: ['cwd'], value: '/tmp' },
      { op: 'set', path: ['panes', 'left', 'cursor'], value: 3 },
    ],
  });
});

test('replace supersedes earlier edits in the same tick', async () => {
  const { model, state, messages } = observed({ a: 1 });
  state.a = 2;
  model.replace({ b: 1 });
  /** @type {any} */ (model.state).b = 2;
  await tick();
  assert.deepEqual(messages, [{ type: 'replace', state: { b: 2 } }]);
});

test('top-level properties come from replace; nested objects are open', async () => {
  const { state, messages } = observed({ cwd: '/', marks: {} });
  assert.throws(() => (state.cwdd = '/tmp'), /"cwdd" isn't registered/);
  assert.throws(() => delete state.cwd, /"cwd" can't be deleted/);
  state.marks['a.txt'] = true;
  delete state.marks['a.txt'];
  delete state.marks.missing;
  await tick();
  assert.deepEqual(messages[0].type === 'patch' && messages[0].patches, [
    { op: 'set', path: ['marks', 'a.txt'], value: true },
    { op: 'delete', path: ['marks', 'a.txt'] },
  ]);
});

test('assigning the same primitive records nothing', async () => {
  const { state, messages } = observed({ cwd: '/' });
  state.cwd = '/';
  await tick();
  assert.deepEqual(messages, []);
});

/** @param {StateMessage} message */
const paths = (message) => (message.type === 'patch' ? message.patches.map((p) => p.path.join('.')) : []);

test('array methods record one set of the whole array; index writes record the index', async () => {
  const { state, messages } = observed({ rows: [{ name: 'a' }, { name: 'b' }], other: 0 });
  assert.equal(state.rows.push({ name: 'c' }), 3);
  assert.deepEqual(state.rows.shift(), { name: 'a' });
  await tick();
  assert.deepEqual(messages[0], { type: 'patch', patches: [{ op: 'set', path: ['rows'], value: [{ name: 'b' }, { name: 'c' }] }] });

  state.rows[0].name = 'B';
  state.rows[2] = { name: 'd' };
  await tick();
  assert.deepEqual(paths(messages[1]), ['rows.0.name', 'rows.2']);
  assert.equal(state.rows.sort().length, 3, 'sort returns the (proxied) array');
});

test('a whole-array patch drops the pending patches under that array', async () => {
  // Regression: patches carry live values, copied at send time. Without this, `rows.1.size` would be sent
  // after a `rows` value that had already been truncated to one item, and the UI would fail to apply it.
  const { state, messages } = observed({ rows: [{ size: 1 }, { size: 2 }], other: 0 });
  state.rows.push({ size: 3 });
  state.other = 1;
  state.rows[1].size = 20;
  state.rows.length = 1;
  await tick();
  assert.deepEqual(paths(messages[0]), ['other', 'rows']);
  assert.deepEqual(messages[0].type === 'patch' && messages[0].patches[1].op === 'set' && messages[0].patches[1].value, [
    { size: 1 },
  ]);
});

test('arrays never get holes', () => {
  const { state } = observed({ rows: [1, 2] });
  assert.throws(() => (state.rows[5] = 3), /indices up to its length \(2\), not "5"/);
  assert.throws(() => (state.rows.x = 3), /not "x"/);
  assert.throws(() => (state.rows.length = 10), /only be shortened/);
  assert.throws(() => delete state.rows[0], /use splice/);
  state.rows[2] = 3;
  assert.deepEqual([...state.rows], [1, 2, 3], 'writing at the length appends');
});

test('reading works through proxies, including array helpers', () => {
  const { state } = observed({ rows: [{ name: 'a', size: 1 }, { name: 'b', size: 2 }] });
  assert.deepEqual(state.rows.map((/** @type {any} */ r) => r.name), ['a', 'b']);
  assert.equal(state.rows.find((/** @type {any} */ r) => r.size === 2).name, 'b');
  assert.equal(state.rows.length, 2);
  assert.equal(JSON.stringify(state), '{"rows":[{"name":"a","size":1},{"name":"b","size":2}]}');
  assert.equal(state.rows, state.rows, 'the same proxy is handed out while the path is unchanged');
});

test('values are copied on the way in and on the way out', async () => {
  const { state, messages } = observed({ pane: null });
  const pane = { cwd: '/' };
  state.pane = pane;
  pane.cwd = '/changed';
  assert.equal(state.pane.cwd, '/', 'later changes to the original do not leak in');

  await tick();
  const sent = messages[0].type === 'patch' && messages[0].patches[0];
  assert.ok(sent && sent.op === 'set');
  /** @type {any} */ (sent.value).cwd = '/mutated by the UI';
  assert.equal(state.pane.cwd, '/', 'a subscriber cannot change the model');
});

test('assigning a state proxy copies its data, so no subtree is shared', () => {
  const { state } = observed({ a: { x: 1 }, b: null });
  state.b = state.a;
  state.b.x = 2;
  assert.equal(state.a.x, 1);
});

test('a stale reference refuses writes', () => {
  const { model, state } = observed({ pane: { cwd: '/' }, rows: [{ n: 1 }, { n: 2 }] });
  const pane = state.pane;
  const second = state.rows[1];
  model.replace({ pane: { cwd: '/' }, rows: [{ n: 1 }, { n: 2 }] });
  assert.throws(() => (pane.cwd = '/tmp'), /Stale state reference "pane"/);

  const rows = /** @type {any} */ (model.state).rows;
  const moved = rows[1];
  rows.shift();
  assert.throws(() => (moved.n = 3), /Stale state reference "rows.1"/);
  assert.throws(() => (second.n = 3), /Stale/);
});

test('only JSON data is accepted, with the offending path in the error', () => {
  const { state } = observed({ a: null });
  const cases = [
    [undefined, /"a" is undefined/],
    [() => {}, /"a" is/],
    [NaN, /"a" is NaN/],
    [new Date(), /"a" is a Date object/],
    [new Map(), /"a" is a Map object/],
    [{ deep: [1, undefined] }, /"a.deep.1" is undefined/],
    // eslint-disable-next-line no-sparse-arrays
    [[1, , 3], /hole at 1/],
    [JSON.parse('{"__proto__": 1}'), /"__proto__" .* is reserved/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => (state.a = value), message);
  }
  const cyclic = /** @type {any} */ ({});
  cyclic.self = cyclic;
  assert.throws(() => (state.a = cyclic), /"a.self" is circular/);
  assert.throws(() => Object.defineProperty(state, 'a', { value: 1 }), /defineProperty/);
  assert.throws(() => Object.freeze(state), /frozen/);
});

test('cloneData allows shared (non-circular) references and null-prototype objects', () => {
  const shared = { x: 1 };
  const copy = /** @type {any} */ (cloneData({ a: shared, b: shared, c: Object.create(null) }));
  assert.deepEqual(copy, { a: { x: 1 }, b: { x: 1 }, c: {} });
  assert.notEqual(copy.a, copy.b);
});

test('subscribing flushes pending edits to earlier subscribers first', () => {
  const { model, state, messages } = observed({ n: 0 });
  state.n = 1;
  /** @type {StateMessage[]} */
  const late = [];
  model.subscribe((message) => late.push(message));
  assert.deepEqual(messages, [{ type: 'patch', patches: [{ op: 'set', path: ['n'], value: 1 }] }]);
  assert.deepEqual(late, [{ type: 'replace', state: { n: 1 } }]);
});

test('a throwing listener does not stop the others; unsubscribe stops delivery', async () => {
  const model = new Model();
  model.replace({ n: 0 });
  /** @type {StateMessage[]} */
  const messages = [];
  model.subscribe((message) => {
    if (message.type === 'patch') {
      throw new Error('listener bug');
    }
  });
  const unsubscribe = model.subscribe((message) => messages.push(message));
  /** @type {any} */ (model.state).n = 1;
  await tick();
  assert.equal(messages.length, 2);

  unsubscribe();
  /** @type {any} */ (model.state).n = 2;
  await tick();
  assert.equal(messages.length, 2);
});
