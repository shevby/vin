const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSystem } = require('../../../fs/file-system');
const { LocalProvider } = require('../../../fs/local');
const { paths } = require('../../../paths');
const { transfer, freeName, within } = require('./operations');

const files = new FileSystem();
files.register('file', new LocalProvider());

/**
 * A temp directory holding `tree` (text for a file, an object for a directory), removed after the test.
 * @typedef {{ [name: string]: string | Tree }} Tree
 * @param {import('node:test').TestContext} t
 * @param {Tree} tree
 */
function tempDir(t, tree) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-ops-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /**
   * @param {string} at
   * @param {Tree} entries
   */
  const write = (at, entries) => {
    for (const [name, content] of Object.entries(entries)) {
      if (typeof content === 'string') {
        fs.writeFileSync(path.join(at, name), content);
      } else {
        fs.mkdirSync(path.join(at, name));
        write(path.join(at, name), content);
      }
    }
  };
  write(dir, tree);
  /** @param {...string} names */
  const uri = (...names) => paths.toUri(path.join(dir, ...names));
  return { dir, uri };
}

/**
 * The tree in a directory, as `tempDir` takes it.
 * @param {string} dir
 * @returns {Tree}
 */
function read(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).map((entry) => [
    entry.name,
    entry.isDirectory() ? read(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8'),
  ]));
}

/**
 * A `resolve` answering from a list, recording the names asked about.
 * @param {import('./operations').Resolution[]} answers
 */
function answering(answers) {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    /** @type {import('./operations').Resolve} */
    resolve: async (conflict) => {
      asked.push(`${conflict.name}${conflict.merge ? ' (merge)' : ''}`);
      const answer = answers.shift();
      assert.ok(answer, `unexpected conflict: ${conflict.name}`);
      return answer;
    },
  };
}

test('copy and move put entries into a directory; a move leaves the source', async (t) => {
  const { dir, uri } = tempDir(t, { a: { 'f.txt': 'f', sub: { g: 'g' } }, b: 'b', to: {} });
  const { resolve } = answering([]);
  const copied = await transfer(files, { mode: 'copy', sources: [uri('a'), uri('b')], destination: uri('to'), resolve });
  assert.deepEqual(copied, { created: ['a', 'b'], done: [uri('a'), uri('b')], skipped: 0, failures: [], cancelled: false });
  assert.deepEqual(read(path.join(dir, 'to')), { a: { 'f.txt': 'f', sub: { g: 'g' } }, b: 'b' });
  fs.rmSync(path.join(dir, 'to'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'to'));
  await transfer(files, { mode: 'move', sources: [uri('a'), uri('b')], destination: uri('to'), resolve });
  assert.deepEqual(read(dir), { to: { a: { 'f.txt': 'f', sub: { g: 'g' } }, b: 'b' } });
});

test('a conflict is asked about: overwrite, skip, keep both, and an answer for all', async (t) => {
  const { dir, uri } = tempDir(t, { src: { a: 'new a', b: 'new b', c: 'new c', d: 'new d' }, to: { a: 'old a', b: 'old b', c: 'old c', d: 'old d' } });
  const { asked, resolve } = answering([{ action: 'overwrite' }, { action: 'skip' }, { action: 'keepBoth', all: true }]);
  const sources = ['a', 'b', 'c', 'd'].map((name) => uri('src', name));
  const outcome = await transfer(files, { mode: 'copy', sources, destination: uri('to'), resolve });
  assert.deepEqual(asked, ['a', 'b', 'c'], 'd takes the answer for all');
  assert.deepEqual(outcome.created, ['a', 'c (2)', 'd (2)']);
  assert.equal(outcome.skipped, 1);
  assert.deepEqual(read(path.join(dir, 'to')), { a: 'new a', b: 'old b', c: 'old c', 'c (2)': 'new c', d: 'old d', 'd (2)': 'new d' });
});

test('cancel stops the rest; a failure stops only its entry', async (t) => {
  const { dir, uri } = tempDir(t, { a: 'a', b: 'b', c: 'c', to: { b: 'old' } });
  const { resolve } = answering([{ action: 'cancel' }]);
  const outcome = await transfer(files, { mode: 'move', sources: [uri('missing'), uri('a'), uri('b'), uri('c')], destination: uri('to'), resolve });
  assert.deepEqual(outcome.created, ['a']);
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(outcome.failures.map((error) => /** @type {any} */ (error).code), ['ENOENT']);
  assert.deepEqual(read(dir), { b: 'b', c: 'c', to: { a: 'a', b: 'old' } });
});

test('overwriting a directory with a directory merges them, asking about each entry there', async (t) => {
  const { dir, uri } = tempDir(t, { src: { d: { same: 'new', only: 'new only', deep: { x: 'new x' } } }, to: { d: { same: 'old', kept: 'kept', deep: { x: 'old x' } } } });
  const { asked, resolve } = answering([{ action: 'overwrite' }, { action: 'overwrite', all: true }]);
  const outcome = await transfer(files, { mode: 'move', sources: [uri('src', 'd')], destination: uri('to'), resolve });
  // Then whichever of its entries there comes first, answered for all.
  assert.equal(asked[0], 'd (merge)');
  assert.equal(asked.length, 2);
  assert.deepEqual(outcome.failures, []);
  assert.deepEqual(read(dir), { src: {}, to: { d: { same: 'new', only: 'new only', kept: 'kept', deep: { x: 'new x' } } } });
});

test('a merge that skips something leaves the moved directory with it', async (t) => {
  const { dir, uri } = tempDir(t, { src: { d: { a: 'new a', b: 'new b' } }, to: { d: { a: 'old a' } } });
  const { resolve } = answering([{ action: 'overwrite' }, { action: 'skip' }]);
  const outcome = await transfer(files, { mode: 'move', sources: [uri('src', 'd')], destination: uri('to'), resolve });
  assert.equal(outcome.skipped, 1);
  assert.deepEqual(read(dir), { src: { d: { a: 'new a' } }, to: { d: { a: 'old a', b: 'new b' } } });
});

test('a copy into its own directory is kept next to it, a move there is left alone, and nothing goes into itself', async (t) => {
  const { dir, uri } = tempDir(t, { 'notes.txt': 'n', d: { inner: {} } });
  const { resolve } = answering([]);
  const copied = await transfer(files, { mode: 'copy', sources: [uri('notes.txt'), uri('d')], destination: uri(), resolve });
  assert.deepEqual(copied.created, ['notes (2).txt', 'd (2)']);
  const moved = await transfer(files, { mode: 'move', sources: [uri('notes.txt')], destination: uri(), resolve });
  assert.deepEqual(moved, { created: [], done: [], skipped: 1, failures: [], cancelled: false });
  const into = await transfer(files, { mode: 'move', sources: [uri('d')], destination: uri('d', 'inner'), resolve });
  assert.match(String(into.failures[0]), /Can't move d into itself/);
  assert.deepEqual(Object.keys(read(dir)).sort(), ['d', 'd (2)', 'notes (2).txt', 'notes.txt']);
});

test('link creates symlinks to the entries', async (t) => {
  const { dir, uri } = tempDir(t, { d: { x: 'x' }, to: {} });
  const outcome = await transfer(files, { mode: 'link', sources: [uri('d')], destination: uri('to'), resolve: answering([]).resolve });
  assert.deepEqual(outcome.created, ['d']);
  assert.ok(fs.lstatSync(path.join(dir, 'to', 'd')).isSymbolicLink());
  assert.deepEqual(read(path.join(dir, 'to', 'd')), { x: 'x' });
});

test('a transfer tells how it goes in bytes, against the total size added up meanwhile', async (t) => {
  const { uri } = tempDir(t, { a: 'aaa', d: { b: 'bb', e: { c: 'c' } }, to: {} });
  /** @type {import('./operations').Progress[]} */
  const reports = [];
  await transfer(files, { mode: 'copy', sources: [uri('a'), uri('d')], destination: uri('to'), resolve: answering([]).resolve, progress: (progress) => reports.push(progress) });
  assert.deepEqual(reports[0], { name: 'a', item: 0, done: 0, total: reports[0].total });
  const last = /** @type {import('./operations').Progress} */ (reports.at(-1));
  assert.deepEqual([last.name, last.item, last.done], ['d', 2, 6]);
  assert.ok(last.total === 6 || last.total === null, `total ${last.total}`);
  assert.ok(reports.some((progress) => progress.name === 'd' && progress.item === 1));
});

test('an aborted signal cancels a transfer, leaving what was done', async (t) => {
  const { dir, uri } = tempDir(t, { a: 'a', b: 'b', to: {} });
  const controller = new AbortController();
  const outcome = await transfer(files, {
    mode: 'copy',
    sources: [uri('a'), uri('b')],
    destination: uri('to'),
    resolve: answering([]).resolve,
    signal: controller.signal,
    progress: ({ done }) => done > 0 && controller.abort(),
  });
  assert.deepEqual([outcome.created, outcome.cancelled, outcome.failures], [['a'], true, []]);
  assert.deepEqual(read(path.join(dir, 'to')), { a: 'a' });
});

test('freeName numbers a name before its extension; within tells a path inside another', async (t) => {
  const { uri } = tempDir(t, { 'a.txt': '', 'a (2).txt': '', '.rc': '' });
  assert.equal(await freeName(files, uri(), 'a.txt', false), 'a (3).txt');
  assert.equal(await freeName(files, uri(), '.rc', false), '.rc (2)');
  assert.equal(await freeName(files, uri(), 'v1.0', true), 'v1.0 (2)', "a directory's name has no extension");
  assert.equal(within(uri('a', 'b'), uri('a')), true);
  assert.equal(within(uri('a'), uri('a')), true);
  assert.equal(within(uri('ab'), uri('a')), false);
  assert.equal(within(uri(), uri('a')), false);
});
