const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Vin = require('../../../vin');
const { paths } = require('../../../paths');
const Pane = require('./pane');

/**
 * A temp directory, removed after the test.
 * @param {import('node:test').TestContext} t
 * @param {{ [name: string]: string | null }} [files] Names to create in it: a file with that text, or a
 *   directory for `null`.
 */
function tempDir(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-pane-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    if (text === null) {
      fs.mkdirSync(path.join(dir, name));
    } else {
      fs.writeFileSync(path.join(dir, name), text);
    }
  }
  return dir;
}

/**
 * A pane showing `dir`, initialized.
 * @param {string} dir
 */
async function open(dir) {
  const vin = new Vin();
  const pane = new Pane('pane', { uri: paths.toUri(dir) });
  vin.register(pane);
  await vin.init();
  return { vin, pane };
}

test('a pane lists its directory: directories first, then names in natural order', async (t) => {
  const dir = tempDir(t, { 'file10.txt': 'ten', 'file2.txt': 'two!', 'B.md': '', src: null, a: null });
  const { pane } = await open(dir);
  assert.equal(pane.state.status, 'loading');
  await pane.loaded;
  assert.equal(pane.state.status, 'ready');
  assert.equal(pane.state.cursor, 0);
  assert.deepEqual(pane.state.entries.map((entry) => entry.name), ['a', 'src', 'B.md', 'file2.txt', 'file10.txt']);
  const [a, , , two] = pane.state.entries;
  assert.equal(a.type, 'directory');
  assert.deepEqual({ ...two, mtime: 0 }, { name: 'file2.txt', type: 'file', symlink: false, executable: false, size: 4, mtime: 0 });
  assert.ok(Math.abs((two.mtime ?? 0) - Date.now()) < 60_000);
});

test('entry details come in batches, each one update', async (t) => {
  const names = Array.from({ length: 600 }, (_, i) => `f${i}`);
  const dir = tempDir(t, Object.fromEntries(names.map((name) => [name, name])));
  const { pane } = await open(dir);
  /** @type {import('../../../state').StateMessage[]} */
  const messages = [];
  pane.subscribeState((message) => messages.push(message));
  await pane.loaded;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pane.state.entries.every((entry) => entry.size === entry.name.length));
  // The current state, the listing, then three batches of details.
  assert.ok(messages.length <= 5, `${messages.length} messages`);
});

test('a directory that can\'t be listed is reported, and the pane stays empty', async (t) => {
  const dir = tempDir(t);
  const { vin, pane } = await open(path.join(dir, 'missing'));
  await pane.loaded;
  assert.equal(pane.state.status, 'failed');
  assert.deepEqual(pane.state.entries, []);
  assert.deepEqual(vin.messages.list.map((message) => message.level), ['error']);
  assert.match(vin.messages.list[0].text, /No such file or directory/);
});

test('disposing a pane while it lists leaves its state alone', async (t) => {
  const dir = tempDir(t, { a: 'a' });
  const { vin, pane } = await open(dir);
  await vin.dispose();
  await pane.loaded;
  assert.deepEqual(vin.messages.list, []);
});

/**
 * @param {Pane} pane
 * @returns {string | null} The name under the cursor.
 */
const current = (pane) => pane.state.entries[pane.state.cursor]?.name ?? null;

test('the cursor moves by one, by pages, and to the ends, staying in the listing', async (t) => {
  const dir = tempDir(t, Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${String(i).padStart(2, '0')}`, ''])));
  const { pane } = await open(dir);
  await pane.loaded;
  pane.up();
  assert.equal(pane.state.cursor, 0, 'already at the top');
  pane.down();
  pane.down();
  assert.equal(pane.state.cursor, 2);
  pane.setPageSize(10);
  pane.pageDown();
  assert.equal(pane.state.cursor, 11, 'a page less a row');
  pane.halfPageDown();
  assert.equal(pane.state.cursor, 16);
  pane.halfPageUp();
  pane.pageUp();
  assert.equal(pane.state.cursor, 2);
  pane.last();
  assert.equal(pane.state.cursor, 49);
  pane.pageDown();
  pane.down();
  assert.equal(pane.state.cursor, 49);
  pane.first();
  assert.equal(pane.state.cursor, 0);
  assert.throws(() => pane.setPageSize(0), TypeError);
});

test('open enters a directory, parent comes back with the cursor on it, and a file says it can\'t be opened yet', async (t) => {
  const dir = tempDir(t, { a: null, b: null, 'f.txt': '' });
  fs.writeFileSync(path.join(dir, 'b', 'inner.txt'), '');
  fs.mkdirSync(path.join(dir, 'b', 'deep'));
  const { vin, pane } = await open(dir);
  await pane.loaded;
  pane.down();
  await pane.open();
  assert.equal(pane.state.uri, paths.toUri(path.join(dir, 'b')));
  assert.deepEqual(pane.state.entries.map((entry) => entry.name), ['deep', 'inner.txt']);
  assert.equal(pane.state.cursor, 0);
  pane.down();
  await pane.toParent();
  assert.equal(pane.state.uri, paths.toUri(dir));
  assert.equal(current(pane), 'b', 'on the directory it came from');
  await pane.open();
  assert.equal(current(pane), 'inner.txt', 'back where it was left');
  await pane.open();
  assert.deepEqual(vin.messages.list.map((message) => message.text), ["Opening files isn't supported yet"]);
  assert.equal(pane.state.uri, paths.toUri(path.join(dir, 'b')));
});

test('back and forward go through the history, which a new directory cuts short', async (t) => {
  const dir = tempDir(t, { a: null, b: null });
  const { pane } = await open(dir);
  await pane.loaded;
  const uri = (/** @type {string[]} */ ...names) => paths.toUri(path.join(dir, ...names));
  await pane.open();
  await pane.toParent();
  await pane.navigate('b');
  assert.equal(pane.state.uri, uri('b'), 'a path, relative to the directory shown');
  await pane.back();
  assert.equal(pane.state.uri, uri());
  await pane.back();
  assert.equal(pane.state.uri, uri('a'));
  await pane.back();
  await pane.back();
  assert.equal(pane.state.uri, uri(), 'the first directory');
  await pane.forward();
  assert.equal(pane.state.uri, uri('a'));
  await pane.navigate(paths.toUri(path.join(dir, 'b')));
  await pane.forward();
  assert.equal(pane.state.uri, uri('b'), 'nothing ahead any more');
  await pane.back();
  assert.equal(pane.state.uri, uri('a'));
});

test('a directory that can\'t be entered is reported, and the pane stays; history drops it', async (t) => {
  const dir = tempDir(t, { a: null, b: null });
  const { vin, pane } = await open(dir);
  await pane.loaded;
  await pane.navigate('b');
  await pane.navigate('../a');
  fs.rmdirSync(path.join(dir, 'b'));
  await pane.back();
  assert.equal(pane.state.uri, paths.toUri(path.join(dir, 'a')), 'stays');
  assert.equal(pane.state.status, 'ready');
  assert.match(vin.messages.list[0]?.text ?? '', /No such file or directory/);
  await pane.back();
  assert.equal(pane.state.uri, paths.toUri(dir), 'past the one dropped');
  await pane.navigate('missing');
  assert.equal(pane.state.uri, paths.toUri(dir));
  assert.equal(vin.messages.list.length, 2);
});

test('home goes to the home directory, and a root has no parent', async (t) => {
  const { pane } = await open(path.parse(os.tmpdir()).root);
  await pane.loaded;
  const root = pane.state.uri;
  await pane.toParent();
  assert.equal(pane.state.uri, root);
  await pane.home();
  assert.equal(pane.state.uri, paths.toUri(paths.home));
});
