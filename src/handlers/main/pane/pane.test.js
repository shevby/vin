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
