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

test('entries are selected one by one and as groups, which add to the selection', async (t) => {
  const dir = tempDir(t, Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [name, ''])));
  const { pane } = await open(dir);
  await pane.loaded;
  assert.deepEqual(pane.targets, ['a'], 'nothing selected: the entry under the cursor');
  pane.toggleSelection();
  pane.down();
  pane.toggleSelection();
  assert.deepEqual(pane.state.selected, ['a', 'c']);
  assert.equal(current(pane), 'd', 'each moves down');
  pane.up();
  pane.toggleSelection();
  assert.deepEqual(pane.state.selected, ['a'], 'again: unselected');

  pane.last();
  pane.groupSelection();
  assert.equal(pane.state.range, 5);
  pane.up();
  pane.up();
  assert.deepEqual(pane.targets, ['a', 'd', 'e', 'f'], 'the group, on top of the selection');
  assert.deepEqual(pane.state.selected, ['a'], 'not added yet');
  pane.groupSelection();
  assert.deepEqual([pane.state.selected, pane.state.range], [['a', 'd', 'e', 'f'], null], 'V ends it');

  pane.first();
  pane.down();
  pane.groupSelection();
  pane.down();
  pane.toggleSelection();
  assert.deepEqual([pane.state.selected, pane.state.range], [['a', 'b', 'c', 'd', 'e', 'f'], null], 'so does v');
  assert.equal(current(pane), 'c', "ending a group doesn't move");

  pane.unselect();
  assert.deepEqual(pane.state.selected, [], 'Escape: unselects');
  pane.toggleSelection();
  pane.groupSelection();
  pane.down();
  pane.unselect();
  assert.deepEqual([pane.state.selected, pane.state.range], [['c'], null], 'Escape: drops the group only');
  pane.invertSelection();
  assert.deepEqual(pane.state.selected, ['a', 'b', 'd', 'e', 'f']);
  pane.selectAll();
  assert.equal(pane.state.selected.length, 6);
});

test('the selection stays through a reload of the directory, and goes with another one', async (t) => {
  const dir = tempDir(t, { a: null, b: '', c: '' });
  const { pane } = await open(dir);
  await pane.loaded;
  pane.selectAll();
  fs.rmSync(path.join(dir, 'c'));
  await pane.navigate('.');
  assert.deepEqual(pane.state.selected, ['a', 'b'], 'what is still there');
  pane.first();
  await pane.open();
  assert.deepEqual(pane.state.selected, []);
  pane.groupSelection();
  await pane.toParent();
  assert.deepEqual([pane.state.selected, pane.state.range], [[], null]);
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

/** Lets queued microtasks and immediates run: state patches, commands started by keys. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Waits for a command started by a key to get somewhere, up to a second.
 * @param {() => unknown} done
 * @param {string} what For the failure.
 */
async function until(done, what) {
  for (const start = Date.now(); !done(); await tick()) {
    if (Date.now() - start > 1000) {
      assert.fail(`Timed out waiting for ${what}`);
    }
  }
}

/**
 * A pane showing `dir` as a window, listed, driven by keys as the UI would.
 * @param {string} dir
 * @param {string} [config] The config file's text.
 */
async function openWindow(dir, config) {
  const vin = new Vin();
  const pane = new Pane('pane', { uri: paths.toUri(dir) });
  vin.register(pane);
  if (config !== undefined) {
    vin.config.parse(config, 'config.json5');
  }
  await vin.init();
  await vin.openWindow('pane');
  await pane.loaded;
  return {
    vin,
    pane,
    /**
     * Presses keys, one chord per space-separated item, letting each command run.
     * @param {string} keys
     */
    async press(keys) {
      for (const chord of keys.split(' ')) {
        await vin.call('core.press', chord);
        await tick();
      }
    },
    /**
     * Types or pastes text, as the UI does with `core.type`.
     * @param {string} text
     */
    async type(text) {
      await vin.call('core.type', text);
      await tick();
    },
    /** The focused handler's kind — a dialog's, while one is open. */
    focus: () => vin.windows.focused?.kind ?? null,
    messages: () => vin.messages.list.map((message) => message.text),
    /** The entry under the cursor. */
    current: () => pane.state.entries[pane.state.cursor]?.name,
  };
}

test('copy and paste make copies, next to the original in its own directory; cut and paste moves, once', async (t) => {
  const dir = tempDir(t, { d: null, 'f.txt': 'f' });
  const { vin, pane, current, messages } = await openWindow(dir);
  pane.down();
  pane.copy();
  assert.deepEqual(vin.clipboard.content, { mode: 'copy', uris: [paths.toUri(path.join(dir, 'f.txt'))] });
  assert.deepEqual(messages(), ['Copied f.txt — paste to copy it']);
  await pane.paste();
  assert.deepEqual(pane.state.entries.map((entry) => entry.name), ['d', 'f (2).txt', 'f.txt']);
  assert.equal(current(), 'f (2).txt', 'the cursor on what was pasted');
  pane.cut();
  await pane.navigate('d');
  await pane.paste();
  assert.deepEqual(fs.readdirSync(path.join(dir, 'd')), ['f (2).txt']);
  assert.equal(vin.clipboard.content, null, 'moved: off the clipboard');
  await pane.paste();
  assert.match(messages().at(-1) ?? '', /Nothing to paste/);
});

test('selected entries go together, and the selection ends; a name taken is asked about', async (t) => {
  const dir = tempDir(t, { to: null, a: 'new a', b: 'new b', c: 'c' });
  fs.writeFileSync(path.join(dir, 'to', 'a'), 'old a');
  fs.writeFileSync(path.join(dir, 'to', 'b'), 'old b');
  const { pane, press, focus, messages } = await openWindow(dir);
  await press('j v v v');
  assert.deepEqual(pane.state.selected, ['a', 'b', 'c']);
  const moved = pane.moveTo('to');
  assert.deepEqual(pane.state.selected, []);
  await until(() => focus() === 'choiceList', 'a to be asked about');
  await press('o');
  await until(() => focus() === 'choiceList', 'b to be asked about');
  await press('enter');
  await moved;
  assert.deepEqual(fs.readdirSync(dir).sort(), ['b', 'to']);
  assert.equal(fs.readFileSync(path.join(dir, 'to', 'a'), 'utf8'), 'new a');
  assert.equal(fs.readFileSync(path.join(dir, 'to', 'b'), 'utf8'), 'old b', 'Enter skips');
  assert.deepEqual(messages(), [`Moved 2 items to ${paths.display(path.join(dir, 'to'))}, skipped 1`]);
});

test('delete asks first, on Delete, and deletes for good; the cursor stays on its row', async (t) => {
  const dir = tempDir(t, { d: null, a: '', b: '', c: '' });
  fs.writeFileSync(path.join(dir, 'd', 'inside'), '');
  const { pane, press, focus, messages, current } = await openWindow(dir);
  await press('j j');
  await press('shift+d shift+d');
  await until(() => focus() === 'confirm', 'the question');
  await press('escape');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a', 'b', 'c', 'd'], 'Escape: kept');
  await press('delete');
  await until(() => focus() === 'confirm', 'the question');
  await press('enter');
  await until(() => current() === 'c', 'the listing');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a', 'c', 'd']);
  assert.equal(current(), 'c');
  assert.deepEqual(messages(), ['Deleted b']);
  await press('g g v shift+g v delete');
  await until(() => focus() === 'confirm', 'the question');
  await press('y');
  await until(() => pane.state.entries.length === 1, 'the listing');
  assert.deepEqual(fs.readdirSync(dir), ['a'], 'a directory, with what is inside');
});

test('with pane.trash, delete moves entries there, keeping both of one name; inside it, and with shift+Delete, deletes for good', async (t) => {
  const dir = tempDir(t, { work: null, trash: null });
  const work = path.join(dir, 'work');
  const trash = path.join(dir, 'trash');
  fs.writeFileSync(path.join(work, 'a'), 'new');
  fs.writeFileSync(path.join(work, 'b'), '');
  fs.writeFileSync(path.join(trash, 'a'), 'old');
  const { pane, press, focus, messages } = await openWindow(work, `{ pane: { trash: ${JSON.stringify(path.join(trash, 'sub'))}, confirmDelete: false } }`);
  fs.renameSync(path.join(trash, 'a'), path.join(dir, 'a-old'));
  await press('delete');
  assert.equal(focus(), 'pane', 'no question');
  await until(() => messages().length, 'the message');
  assert.deepEqual(messages(), ['Moved a to the trash']);
  assert.deepEqual(fs.readdirSync(path.join(trash, 'sub')), ['a'], 'created when first needed');
  fs.writeFileSync(path.join(work, 'a'), 'again');
  await pane.reload();
  pane.first();
  await press('delete');
  await until(() => messages().length, 'the message');
  assert.deepEqual(fs.readdirSync(path.join(trash, 'sub')).sort(), ['a', 'a (2)']);
  await press('shift+delete');
  await until(() => messages().length, 'the message');
  assert.deepEqual(fs.readdirSync(work), []);
  assert.deepEqual(fs.readdirSync(path.join(trash, 'sub')).sort(), ['a', 'a (2)'], 'b: deleted for good');
  await pane.navigate(path.join(trash, 'sub'));
  await press('delete');
  await until(() => messages().length, 'the message');
  assert.deepEqual(fs.readdirSync(path.join(trash, 'sub')), ['a (2)'], 'in the trash: for good');
});

test('pane.trash must be an absolute path', async (t) => {
  const dir = tempDir(t, { a: '' });
  const { press, messages } = await openWindow(dir, `{ pane: { trash: 'relative/trash' } }`);
  await press('delete');
  await until(() => messages().length, 'the message');
  assert.match(messages()[0] ?? '', /^pane\.trash in the config must be an absolute path/);
  assert.deepEqual(fs.readdirSync(dir), ['a']);
});

test('rename starts with the name, the cursor before its extension; a name taken is refused until changed', async (t) => {
  const dir = tempDir(t, { 'notes.txt': '', 'other.txt': '' });
  const { vin, pane, press, type, focus, current } = await openWindow(dir);
  await press('c w');
  await until(() => focus() === 'textField', 'the prompt');
  const input = /** @type {any} */ (vin.windows.focused);
  assert.deepEqual([input.state.value, input.state.cursor], ['notes.txt', 5]);
  await press('ctrl+u');
  await type('other');
  await press('enter');
  await until(() => input.parent.state.error, 'the error');
  assert.equal(input.parent.state.error, 'other.txt already exists');
  await press('ctrl+a ctrl+k');
  await type('Notes.md');
  await press('enter');
  await until(() => current() === 'Notes.md', 'the listing');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Notes.md', 'other.txt']);
  assert.equal(current(), 'Notes.md');
  for (const keys of ['c c', 'c a w', 'c i w']) {
    await press(keys);
    await until(() => focus() === 'textField', keys);
    await press('escape');
  }
});

test('create makes a file, or a directory for a name ending with /, with the directories on the way', async (t) => {
  const dir = tempDir(t, { taken: '' });
  const { vin, press, type, focus, current } = await openWindow(dir);
  await press('a');
  await until(() => focus() === 'textField', 'the prompt');
  await type('taken');
  await press('enter');
  await until(() => /** @type {any} */ (vin.windows.focused)?.parent.state.error, 'the error');
  assert.equal(focus(), 'textField', 'taken: the prompt stays');
  await press('ctrl+u');
  await type('src/lib/');
  await press('enter');
  await until(() => current() === 'src', 'the listing');
  await press('a');
  await until(() => focus() === 'textField', 'the prompt');
  await type('file.txt');
  await press('enter');
  await until(() => current() === 'file.txt', 'the listing');
  assert.ok(fs.statSync(path.join(dir, 'src', 'lib')).isDirectory());
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), '');
  assert.equal(current(), 'file.txt');
});

test('a paste of paths pastes those entries; vin\'s own cut paths move them; other text is refused', async (t) => {
  const dir = tempDir(t, { to: null, a: 'a', b: 'b' });
  const { vin, pane, type, messages } = await openWindow(path.join(dir, 'to'));
  await type(`"${path.join(dir, 'a')}"`);
  await until(() => pane.state.entries.length === 1, 'the listing');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'to')), ['a']);
  assert.ok(fs.existsSync(path.join(dir, 'a')), 'copied');
  vin.clipboard.set('cut', [paths.toUri(path.join(dir, 'b'))]);
  await type(`${path.join(dir, 'b')}\r`);
  await until(() => pane.state.entries.length === 2, 'the listing');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'to')).sort(), ['a', 'b']);
  assert.ok(!fs.existsSync(path.join(dir, 'b')), 'moved');
  await type('hello');
  assert.deepEqual(messages(), ['Only paths can be pasted here, one per line']);
});

test('shift+p pastes symlinks to what is on the clipboard', async (t) => {
  const dir = tempDir(t, { to: null, d: null });
  const { vin, pane, press } = await openWindow(path.join(dir, 'to'));
  vin.clipboard.set('copy', [paths.toUri(path.join(dir, 'd'))]);
  await press('shift+p');
  await until(() => pane.state.entries.length === 1, 'the listing');
  assert.ok(fs.lstatSync(path.join(dir, 'to', 'd')).isSymbolicLink());
  assert.deepEqual(pane.state.entries.map(({ name, type, symlink }) => ({ name, type, symlink })), [{ name: 'd', type: 'directory', symlink: true }]);
});

test('c w on a selection renames it with one name: $n, $i, $e, previewed; names among them swap', async (t) => {
  const dir = tempDir(t, { 'a.mkv': 'a', 'b.mkv': 'b', 'c.mkv': 'c', 'x1.mkv': 'x' });
  const { vin, pane, press, type, focus, messages } = await openWindow(dir);
  await press('v v v c w');
  await until(() => focus() === 'textField' || messages().length, 'the prompt');
  assert.deepEqual(messages(), []);
  const input = /** @type {any} */ (vin.windows.focused);
  const prompt = input.parent;
  assert.deepEqual([input.state.value, input.state.cursor], ['.mkv', 0], 'the extension they share');
  assert.equal(prompt.state.preview, null);
  await type('x$n');
  assert.equal(prompt.state.preview, 'a.mkv → x1.mkv\nb.mkv → x2.mkv\nc.mkv → x3.mkv');
  await press('enter');
  await until(() => prompt.state.error, 'the error');
  assert.equal(prompt.state.error, 'x1.mkv already exists', 'x1.mkv is not being renamed');
  await press('ctrl+a ctrl+k');
  await type('e$n$e');
  await press('enter');
  await until(() => messages().length, 'the message');
  assert.deepEqual(messages(), ['Renamed 3 of 3 items']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['e1.mkv', 'e2.mkv', 'e3.mkv', 'x1.mkv']);
  assert.deepEqual(pane.state.selected, []);

  await press('g g shift+v j j shift+v c w');
  await until(() => focus() === 'textField', 'the prompt');
  await type('e$i');
  await press('enter');
  await until(() => messages().length, 'the message');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['e0.mkv', 'e1.mkv', 'e2.mkv', 'x1.mkv']);
  assert.deepEqual(['e0.mkv', 'e1.mkv', 'e2.mkv'].map((name) => fs.readFileSync(path.join(dir, name), 'utf8')), ['a', 'b', 'c']);
});
