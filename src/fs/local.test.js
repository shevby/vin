const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { text } = require('node:stream/consumers');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { LocalProvider } = require('./local');
const { paths } = require('../paths');

const local = new LocalProvider();

/**
 * A temp directory, removed after the test, and a function giving the URI of a path inside it.
 * @param {import('node:test').TestContext} t
 */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-fs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @param {...string} names */
  const uri = (...names) => paths.toUri(path.join(dir, ...names));
  return { dir, uri };
}

/**
 * Creates a symlink to a directory — on Windows a junction, which needs no privileges and which Node reports
 * as a symlink too — or returns false where this user can't.
 * @param {string} target An absolute path; it needn't exist.
 * @param {string} link
 */
function symlink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EPERM') {
      return false;
    }
    throw error;
  }
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(/** @type {NodeJS.ErrnoException} */ (error).code, code);
    return true;
  });
}

test('stat and readDirectory type entries, following symlinks', async (t) => {
  const { dir, uri } = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(dir, 'sub'));

  const file = await local.stat(uri('a.txt'));
  assert.equal(file.type, 'file');
  assert.equal(file.symlink, false);
  assert.equal(file.size, 5);
  assert.ok(Math.abs(file.mtime - Date.now()) < 60_000);
  assert.equal((await local.stat(uri('sub'))).type, 'directory');
  await rejectsWith(local.stat(uri('missing')), 'ENOENT');

  /** @type {[string, string, boolean][]} */
  const expected = [['a.txt', 'file', false], ['sub', 'directory', false]];
  if (symlink(path.join(dir, 'sub'), path.join(dir, 'link'))) {
    symlink(path.join(dir, 'gone'), path.join(dir, 'broken'));
    expected.push(['broken', 'unknown', true], ['link', 'directory', true]);
    assert.deepEqual({ ...(await local.stat(uri('link'))), mtime: 0, ctime: 0, mode: 0, size: 0 },
      { type: 'directory', symlink: true, mtime: 0, ctime: 0, mode: 0, size: 0, executable: false });
    assert.equal((await local.stat(uri('broken'))).type, 'unknown');
  } else {
    t.diagnostic('symlinks skipped: this user may not create them');
  }
  const entries = (await local.readDirectory(uri())).map((e) => [e.name, e.type, e.symlink]);
  assert.deepEqual(entries.sort(), expected.sort());
  await rejectsWith(local.readDirectory(uri('a.txt')), 'ENOTDIR');
});

test('stat tells executables: by execute bit on Unix, by extension on Windows', async (t) => {
  const { dir, uri } = tempDir(t);
  for (const name of ['run.sh', 'run.EXE', 'run.bat', 'app.js', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  fs.mkdirSync(path.join(dir, 'bin.exe'));
  /**
   * @param {InstanceType<typeof LocalProvider>} provider
   * @returns {Promise<string[]>} The names it calls executable.
   */
  const executables = async (provider) => {
    const names = fs.readdirSync(dir);
    const stats = await Promise.all(names.map((name) => provider.stat(uri(name))));
    return names.filter((_, i) => stats[i].executable).sort();
  };
  assert.deepEqual(await executables(new LocalProvider({ platform: 'win32' })), ['run.EXE', 'run.bat'],
    'extensions ignore case; never a directory, nor a Windows Script Host script');
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
    assert.deepEqual(await executables(new LocalProvider({ platform: 'linux' })), ['run.sh']);
  }
});

test('createDirectory, writeFile and readFile refuse to replace unless asked', async (t) => {
  const { uri } = tempDir(t);
  await local.createDirectory(uri('d'));
  await rejectsWith(local.createDirectory(uri('d')), 'EEXIST');
  await rejectsWith(local.createDirectory(uri('x', 'y')), 'ENOENT');
  await local.createDirectory(uri('x', 'y'), { recursive: true });
  await local.createDirectory(uri('x', 'y'), { recursive: true });

  await local.writeFile(uri('d', 'f'), 'one');
  await rejectsWith(local.writeFile(uri('d', 'f'), 'two'), 'EEXIST');
  await local.writeFile(uri('d', 'f'), new Uint8Array([0x74, 0x77, 0x6f]), { overwrite: true });
  assert.equal(Buffer.from(await local.readFile(uri('d', 'f'))).toString(), 'two');
  await rejectsWith(local.writeFile(uri('nope', 'f'), 'x'), 'ENOENT');
  await rejectsWith(local.readFile(uri('d')), 'EISDIR');
});

test('delete takes a tree only when recursive, and a symlink never deletes its target', async (t) => {
  const { dir, uri } = tempDir(t);
  fs.mkdirSync(path.join(dir, 'tree', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tree', 'deep', 'f'), '');
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.writeFileSync(path.join(dir, 'f'), '');

  await local.delete(uri('f'));
  await local.delete(uri('empty'));
  await rejectsWith(local.delete(uri('tree')), 'ENOTEMPTY');
  if (symlink(path.join(dir, 'tree'), path.join(dir, 'link'))) {
    await local.delete(uri('link'), { recursive: true });
    assert.ok(fs.existsSync(path.join(dir, 'tree', 'deep', 'f')));
  }
  await local.delete(uri('tree'), { recursive: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  await rejectsWith(local.delete(uri('f')), 'ENOENT');
});

test('rename and copy move whole trees, overwrite only when asked, and keep timestamps', async (t) => {
  const { dir, uri } = tempDir(t);
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'deep', 'f'), 'data');
  const old = new Date('2020-01-02T03:04:05Z');
  fs.utimesSync(path.join(dir, 'src', 'deep', 'f'), old, old);
  fs.writeFileSync(path.join(dir, 'other'), 'other');

  await local.copy(uri('src'), uri('copy'));
  assert.equal(fs.readFileSync(path.join(dir, 'copy', 'deep', 'f'), 'utf8'), 'data');
  assert.equal(fs.statSync(path.join(dir, 'copy', 'deep', 'f')).mtimeMs, old.getTime());
  await rejectsWith(local.copy(uri('src'), uri('copy')), 'EEXIST');
  await rejectsWith(local.copy(uri('src'), uri('src')), 'EINVAL');
  await local.copy(uri('other'), uri('copy'), { overwrite: true });
  assert.equal(fs.readFileSync(path.join(dir, 'copy'), 'utf8'), 'other', 'a file replaces a directory');

  await rejectsWith(local.rename(uri('src'), uri('other')), 'EEXIST');
  await local.rename(uri('src'), uri('moved'));
  await rejectsWith(local.rename(uri('moved', 'deep'), uri('moved'), { overwrite: true }), 'EINVAL');
  assert.ok(fs.existsSync(path.join(dir, 'moved', 'deep', 'f')), 'nothing was deleted');
  await local.rename(uri('moved'), uri('other'), { overwrite: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['copy', 'other']);
  await rejectsWith(local.rename(uri('missing'), uri('x')), 'ENOENT');
});

test("changing a name's case is a rename, even where the file system ignores case", async (t) => {
  const { dir, uri } = tempDir(t);
  fs.writeFileSync(path.join(dir, 'name'), 'kept');
  await local.rename(uri('name'), uri('NAME'));
  assert.deepEqual(fs.readdirSync(dir), ['NAME']);
  assert.equal(fs.readFileSync(path.join(dir, 'NAME'), 'utf8'), 'kept');
});

test('streams read a byte range and write a new file, failing before they are returned', async (t) => {
  const { uri } = tempDir(t);
  await local.writeFile(uri('f'), '0123456789');
  assert.equal(await text(await local.createReadStream(uri('f'))), '0123456789');
  assert.equal(await text(await local.createReadStream(uri('f'), { start: 2, end: 4 })), '234');
  await rejectsWith(local.createReadStream(uri('missing')), 'ENOENT');

  await pipeline(Readable.from(['a', 'b']), await local.createWriteStream(uri('g')));
  assert.equal(Buffer.from(await local.readFile(uri('g'))).toString(), 'ab');
  await rejectsWith(local.createWriteStream(uri('g')), 'EEXIST');
  await pipeline(Readable.from(['c']), await local.createWriteStream(uri('g'), { overwrite: true }));
  assert.equal(Buffer.from(await local.readFile(uri('g'))).toString(), 'c');
});

test('watch reports created, changed and deleted entries until stopped', async (t) => {
  const { dir, uri } = tempDir(t);
  /** @type {import('./file-system').FileChange[]} */
  const changes = [];
  /** @type {() => void} */
  let wake = () => {};
  const stop = local.watch(uri(), (change) => {
    changes.push(change);
    wake();
  });
  t.after(stop);
  /** @param {(change: import('./file-system').FileChange) => boolean} match */
  const seen = async (match) => {
    const deadline = Date.now() + 5000;
    while (!changes.some(match)) {
      assert.ok(Date.now() < deadline, `no such change in ${JSON.stringify(changes)}`);
      await new Promise((resolve) => {
        wake = () => resolve(undefined);
        setTimeout(resolve, 50);
      });
    }
  };

  fs.writeFileSync(path.join(dir, 'f'), 'x');
  await seen((c) => c.uri === uri('f') && c.type !== 'deleted');
  fs.rmSync(path.join(dir, 'f'));
  await seen((c) => c.uri === uri('f') && c.type === 'deleted');
  stop();
  const count = changes.length;
  fs.writeFileSync(path.join(dir, 'g'), 'x');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(changes.length, count, 'nothing after stopping');
  assert.throws(() => local.watch(uri('missing'), () => {}), { code: 'ENOENT' });
});
