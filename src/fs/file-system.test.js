const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSystem } = require('./file-system');
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
