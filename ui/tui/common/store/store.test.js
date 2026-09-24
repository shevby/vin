import test from 'node:test';
import assert from 'node:assert/strict';
import { Model } from '../../../../src/state.js';
import { applyPatches, createStore } from './store.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('applyPatches copies patched paths and shares everything else', () => {
  /** @type {any} */
  const state = Object.freeze({
    left: Object.freeze({ cwd: '/', rows: Object.freeze([{ name: 'a' }]) }),
    right: Object.freeze({ cwd: '/' }),
  });
  const next = /** @type {any} */ (applyPatches(state, [
    { op: 'set', path: ['left', 'cwd'], value: '/tmp' },
    { op: 'set', path: ['left', 'hidden'], value: true },
    { op: 'delete', path: ['left', 'hidden'] },
  ]));
  assert.deepEqual(next.left, { cwd: '/tmp', rows: [{ name: 'a' }] });
  assert.equal(next.right, state.right, 'untouched subtree keeps its identity');
  assert.equal(next.left.rows, state.left.rows, 'untouched sibling keeps its identity');
  assert.equal(state.left.cwd, '/', 'the input is not mutated (frozen objects would throw)');
});

test('applyPatches reports a patch through a non-object', () => {
  assert.throws(() => applyPatches({ a: 1 }, [{ op: 'set', path: ['a', 'b'], value: 2 }]), /"a" isn't an object/);
});

/**
 * A small seeded PRNG (mulberry32), so a failing random sequence can be replayed.
 * @param {number} seed
 */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the store mirrors a model through random edits, tick after tick', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rand = random(seed);
    /** @param {number} n */
    const int = (n) => Math.floor(rand() * n);
    const item = () => ({ v: int(100), tags: [int(10)] });

    const model = new Model();
    model.replace({ rows: [item(), item()], obj: { a: { v: 1 } }, n: 0 });
    const store = createStore();
    model.subscribe(store.apply);

    /** @type {((s: any) => void)[]} */
    const edits = [
      (s) => s.rows.push(item()),
      (s) => s.rows.pop(),
      (s) => s.rows.shift(),
      (s) => s.rows.unshift(item(), item()),
      (s) => s.rows.splice(int(s.rows.length + 1), int(3), item()),
      (s) => s.rows.sort((/** @type {any} */ a, /** @type {any} */ b) => a.v - b.v),
      (s) => s.rows.reverse(),
      (s) => (s.rows.length = int(s.rows.length + 1)),
      (s) => s.rows.length && (s.rows[int(s.rows.length)].v = int(100)),
      (s) => (s.rows[int(s.rows.length + 1)] = item()),
      (s) => s.rows.length && s.rows[int(s.rows.length)].tags.push(int(10)),
      (s) => s.rows.length && s.rows[int(s.rows.length)].tags.shift(),
      (s) => (s.rows = [item()]),
      (s) => (s.obj['k' + int(4)] = { v: int(100) }),
      (s) => delete s.obj['k' + int(4)],
      (s) => s.obj.a && (s.obj.a.v = int(100)),
      (s) => (s.obj = {}),
      (s) => (s.n = int(100)),
    ];

    for (let t = 0; t < 200; t++) {
      for (let i = int(10); i >= 0; i--) {
        edits[int(edits.length)](model.state);
      }
      await tick();
      assert.deepEqual(store.getSnapshot(), JSON.parse(JSON.stringify(model.state)), `seed ${seed}, tick ${t}`);
    }
  }
});

test('the store mirrors a model through any sequence of edits', async () => {
  const model = new Model();
  model.replace({ cwd: '/', rows: [], marks: {}, sort: { by: 'name', desc: false } });
  const store = createStore();
  let notified = 0;
  store.subscribe(() => notified++);
  model.subscribe(store.apply);

  const state = /** @type {any} */ (model.state);
  state.rows.push({ name: 'b', size: 2 }, { name: 'a', size: 1 });
  state.rows.sort((/** @type {any} */ x, /** @type {any} */ y) => x.name.localeCompare(y.name));
  state.rows[1].size = 20;
  state.marks['a'] = true;
  state.sort = { by: 'size', desc: true };
  state.sort.desc = false;
  delete state.marks['a'];
  state.rows.splice(0, 1, { name: 'z', size: 0 });
  state.rows.length = 1;
  await tick();

  assert.deepEqual(store.getSnapshot(), {
    cwd: '/',
    rows: [{ name: 'z', size: 0 }],
    marks: {},
    sort: { by: 'size', desc: false },
  });
  assert.equal(notified, 2, 'one notification for the initial snapshot, one for the whole tick');
});
