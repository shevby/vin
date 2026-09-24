const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Vin = require('../../../vin');
const { paths } = require('../../../paths');
const { failure } = require('../../../errors');
const { opener } = require('../../../open');
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

test('open opens a file with the default app, reporting a failure when it comes; enter only enters', async (t) => {
  const dir = tempDir(t, { d: null, 'f.txt': '', 'g h.txt': '' });
  const { vin, pane } = await open(dir);
  await pane.loaded;
  /** @type {string[]} */
  const opened = [];
  t.mock.method(opener, 'openWithDefaultApp', async (/** @type {string} */ file) => {
    opened.push(file);
    if (file.endsWith('h.txt')) {
      throw failure("Can't open g h.txt: no app");
    }
  });
  pane.down();
  await pane.enter();
  assert.deepEqual(opened, [], 'enter: nothing on a file');
  assert.equal(pane.state.uri, paths.toUri(dir));
  await pane.open();
  pane.down();
  await pane.open();
  assert.deepEqual(opened, [path.join(dir, 'f.txt'), path.join(dir, 'g h.txt')]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(vin.messages.list.map((message) => message.text), ["Can't open g h.txt: no app"]);
  pane.first();
  await pane.enter();
  assert.equal(pane.state.uri, paths.toUri(path.join(dir, 'd')));
});

test('open enters a directory, and parent comes back with the cursor on it', async (t) => {
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
  assert.deepEqual(vin.messages.list, []);
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

test('home goes to the home directory, and a root has no parent', { skip: process.platform === 'win32' }, async () => {
  const { pane } = await open('/');
  await pane.loaded;
  await pane.toParent();
  assert.equal(pane.state.uri, 'file:///');
  await pane.home();
  assert.equal(pane.state.uri, paths.toUri(paths.home));
});

test('on Windows, above a drive is the list of drives, with their free space', { skip: process.platform !== 'win32' }, async (t) => {
  const root = path.parse(os.tmpdir()).root;
  const drive = root[0].toLowerCase();
  const { vin, pane } = await open(root);
  // Only this drive: another could be a disconnected network drive, which takes seconds to answer.
  const local = vin.fs.provider('file:///');
  const readDirectory = local.readDirectory.bind(local);
  t.mock.method(local, 'readDirectory', async (/** @type {string} */ uri) => uri === 'file:///'
    ? [{ name: drive, type: 'directory', symlink: false }]
    : readDirectory(uri));
  await pane.loaded;
  await pane.toParent();
  assert.equal(pane.state.uri, 'file:///');
  assert.equal(current(pane), drive, 'on the drive it came from');
  await pane.loaded;
  assert.ok((pane.state.entries[0].free ?? 0) > 0);
  await pane.toParent();
  assert.equal(pane.state.uri, 'file:///', 'the top');
  await pane.open();
  assert.equal(pane.state.uri, paths.toUri(root));
  await pane.navigate('/');
  assert.equal(pane.state.uri, 'file:///', '/ is the list of drives');
  await pane.navigate(`${drive}/`);
  assert.equal(pane.state.uri, paths.toUri(root), 'a drive, relative to it');
  await pane.home();
  assert.equal(pane.state.uri, paths.toUri(paths.home));
});

test('an entry slow to stat doesn\'t hold up the others\' details', async (t) => {
  const dir = tempDir(t, { fast: 'x', slow: 'xx' });
  const { vin, pane } = await open(dir);
  const local = vin.fs.provider('file:///');
  const stat = local.stat.bind(local);
  /** @type {() => void} */
  let release = () => {};
  const held = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  t.mock.method(local, 'stat', async (/** @type {string} */ uri) => {
    if (uri.endsWith('/slow')) {
      await held;
    }
    return stat(uri);
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(pane.state.entries.map((entry) => entry.size), [1, null]);
  release();
  await pane.loaded;
  assert.deepEqual(pane.state.entries.map((entry) => entry.size), [1, 2]);
});
