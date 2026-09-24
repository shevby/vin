const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSystem, childUri, parentUri } = require('./file-system');
const Vin = require('../vin');
const Handler = require('../handler');
const { paths } = require('../paths');

/**
 * A provider that records calls and answers every one with its name; no `copy`.
 * @param {string[]} calls
 * @returns {import('./file-system').FileSystemProvider}
 */
function fakeProvider(calls) {
  /** @param {string} name */
  const method = (name) => async (/** @type {unknown[]} */ ...args) => {
    calls.push(`${name} ${args.filter((a) => typeof a === 'string').join(' ')}`);
    return /** @type {any} */ (name);
  };
  return /** @type {any} */ ({
    stat: method('stat'),
    readDirectory: method('readDirectory'),
    createDirectory: method('createDirectory'),
    readFile: method('readFile'),
    writeFile: method('writeFile'),
    delete: method('delete'),
    rename: method('rename'),
    createReadStream: method('createReadStream'),
    createWriteStream: method('createWriteStream'),
    watch: () => () => {},
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {RegExp} message
 */
async function rejectsWith(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(/** @type {NodeJS.ErrnoException} */ (error).code, code);
    assert.match(/** @type {Error} */ (error).message, message);
    return true;
  });
}

test("a URI's scheme picks the provider, in any case", async () => {
  const fileSystem = new FileSystem();
  /** @type {string[]} */
  const calls = [];
  const unregister = fileSystem.register('Mem', fakeProvider(calls));
  assert.equal(await fileSystem.stat('mem:/a'), 'stat');
  assert.equal(await fileSystem.rename('MEM:/a', 'mem:/b'), 'rename');
  assert.deepEqual(calls, ['stat mem:/a', 'rename MEM:/a mem:/b']);

  assert.throws(() => fileSystem.register('mem', fakeProvider([])), /"mem" scheme already has a file system provider/);
  assert.throws(() => fileSystem.register('1x', fakeProvider([])), /Invalid URI scheme "1x"/);
  assert.throws(() => fileSystem.register('a:b', fakeProvider([])), /Invalid URI scheme/);
  unregister();
  await rejectsWith(fileSystem.stat('mem:/a'), 'ENOPROVIDER', /^ENOPROVIDER: No file system for "mem:", 'mem:\/a'$/);
  await rejectsWith(fileSystem.stat('C:\\x'), 'ENOPROVIDER', /No file system for "C:"/);
  // A path where a URI belongs is a bug, not a failure to report.
  await assert.rejects(fileSystem.readFile('/etc/hosts'), {
    name: 'TypeError',
    message: /isn't a URI; a path needs paths\.toUri\(\)/,
  });
});

test('moving or copying between providers waits for 5.5; one without copy says so', async () => {
  const fileSystem = new FileSystem();
  fileSystem.register('a', fakeProvider([]));
  fileSystem.register('b', fakeProvider([]));
  await rejectsWith(fileSystem.rename('a:/x', 'b:/x'), 'EXDEV', /Can't move between file systems yet, 'a:\/x' -> 'b:\/x'$/);
  await rejectsWith(fileSystem.copy('a:/x', 'b:/x'), 'EXDEV', /Can't copy between file systems yet/);
  await rejectsWith(fileSystem.copy('a:/x', 'a:/y'), 'ENOSYS', /This file system can't copy yet/);
});

test('handlers reach the local disk as this.fs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-fs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');

  class Lister extends Handler {
    async list() {
      const entries = await this.fs.readDirectory(paths.toUri(dir));
      return entries.map((entry) => entry.name);
    }
  }
  const vin = new Vin();
  vin.register(new Lister('lister'));
  await vin.init();
  assert.deepEqual(await vin.call('lister.list'), ['hello.txt']);
  assert.throws(() => new Lister('orphan').fs, /can't access files: its top-level handler isn't registered/);
});

test('childUri names an entry of a directory, whatever the scheme', () => {
  assert.equal(childUri('sftp://host/home/me', 'a b'), 'sftp://host/home/me/a%20b');
  assert.equal(childUri('file:///', 'x'), 'file:///x');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-uri-'));
  try {
    for (const name of ['a b', '100%', 'x#y', 'ж.txt', "it's", 'a;b=c']) {
      assert.equal(paths.fromUri(childUri(paths.toUri(dir), name)), path.join(dir, name), name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parentUri gives the containing directory and the name in it — a drive's is the list of drives — and null for a root", () => {
  assert.deepEqual(parentUri('sftp://host/home/me/a%20b'), { uri: 'sftp://host/home/me', name: 'a b' });
  assert.deepEqual(parentUri('sftp://host/home/'), { uri: 'sftp://host/', name: 'home' });
  assert.equal(parentUri('sftp://host/'), null);
  const dir = path.join(os.tmpdir(), 'a b');
  assert.deepEqual(parentUri(childUri(paths.toUri(dir), "it's;1")), { uri: paths.toUri(dir), name: "it's;1" });
  assert.deepEqual(parentUri(paths.toUri(dir)), { uri: paths.toUri(os.tmpdir()), name: 'a b' });
  const root = path.parse(os.tmpdir()).root;
  if (process.platform === 'win32') {
    assert.deepEqual(parentUri(paths.toUri(root)), { uri: 'file:///', name: root[0].toLowerCase() }, 'a drive: in the list');
    assert.equal(parentUri('file:///'), null, 'the list of drives');
    assert.equal(parentUri('file://server/share/'), null, 'a share is a root');
    assert.deepEqual(parentUri('file://server/share/x'), { uri: 'file://server/share/', name: 'x' });
  } else {
    assert.equal(parentUri(paths.toUri(root)), null, root);
  }
});
