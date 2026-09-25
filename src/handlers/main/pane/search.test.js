const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileSystem } = require('../../../fs/file-system');
const { LocalProvider } = require('../../../fs/local');
const { paths } = require('../../../paths');
const { matcher, splitPath, walk } = require('./search');

/**
 * @param {string} query
 * @param {string[]} names
 * @returns {string[]} Those it matches.
 */
function matches(query, names) {
  const { test: match, error } = matcher(query);
  assert.equal(error, null, query);
  return names.filter((name) => /** @type {(name: string) => boolean} */ (match)(name));
}

const NAMES = ['report.pdf', 'PREP.txt', 'notes.md', 'readme.MD', 'a+b (1).txt', 'rex.js', 'r.x'];

test('a query is a wildcard pattern found anywhere in a name, ignoring case unless it has a capital', () => {
  assert.deepEqual(matches('', NAMES), NAMES, 'empty: everything');
  assert.deepEqual(matches('rep', NAMES), ['report.pdf', 'PREP.txt']);
  assert.deepEqual(matches('REP', NAMES), ['PREP.txt'], 'smart case');
  assert.deepEqual(matches('*.md', NAMES), ['notes.md', 'readme.MD']);
  assert.deepEqual(matches('r?x', NAMES), ['rex.js', 'r.x']);
  assert.deepEqual(matches('r.x', NAMES), ['r.x'], 'a dot is a dot');
  assert.deepEqual(matches('a+b (1)', NAMES), ['a+b (1).txt'], 'regex characters are literal');
  assert.deepEqual(matches('e*.t', NAMES), ['PREP.txt']);
});

test('a query starting with / is a regular expression, its closing / and flags optional', () => {
  assert.deepEqual(matches('/re.+x/', ['reindex.txt', 'rex.js', 'index']), ['reindex.txt']);
  assert.deepEqual(matches('/^re?x/', NAMES), ['rex.js']);
  assert.deepEqual(matches('/\\.md$/', NAMES), ['notes.md'], 'as typed, case included');
  assert.deepEqual(matches('/\\.md$/i', NAMES), ['notes.md', 'readme.MD']);
  assert.deepEqual(matches('/^r.x$', NAMES), ['r.x'], 'not closed yet');
  assert.deepEqual(matches('/a/b', ['a/b', 'ab']), ['a/b'], 'b is no flag: part of the expression');
  const bad = matcher('/(re');
  assert.equal(bad.test, null);
  assert.match(/** @type {string} */ (bad.error), /Unterminated group/);
});

test('splitPath splits a path found in a tree into its directory and name', () => {
  assert.deepEqual(splitPath('src/lib/x.js'), { directory: 'src/lib', name: 'x.js' });
  assert.deepEqual(splitPath('x.js'), { directory: '', name: 'x.js' });
});

test('walk yields the tree breadth-first, directory by directory; hidden ones are marked, or left out', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['a/b/c', '.git/objects', 'd']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  for (const name of ['top.txt', 'a/one.txt', 'a/b/c/deep.txt', '.git/objects/x', 'd/.env']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  const files = new FileSystem();
  files.register('file', new LocalProvider());
  const root = paths.toUri(dir);
  /**
   * @param {Partial<Parameters<typeof walk>[2]>} options
   * @returns {Promise<string[][]>}
   */
  const collect = async (options) => {
    const batches = [];
    for await (const found of walk(files, root, { showHidden: true, current: () => true, ...options })) {
      batches.push(found.map((entry) => `${entry.name}${entry.hidden ? ' (hidden)' : ''}`).sort());
    }
    return batches;
  };
  const all = await collect({});
  assert.deepEqual(all[0], ['.git (hidden)', 'a', 'd', 'top.txt']);
  assert.deepEqual(all.flat().sort(), [
    '.git (hidden)', '.git/objects (hidden)', '.git/objects/x (hidden)', 'a', 'a/b', 'a/b/c', 'a/b/c/deep.txt', 'a/one.txt',
    'd', 'd/.env (hidden)', 'top.txt',
  ]);
  const shown = (await collect({ showHidden: false })).flat().sort();
  assert.deepEqual(shown, ['a', 'a/b', 'a/b/c', 'a/b/c/deep.txt', 'a/one.txt', 'd', 'top.txt']);
  const marked = (await collect({ showHidden: false, marked: (name) => name === 'a/b' })).flat().sort();
  assert.deepEqual(marked, ['a', 'a/one.txt', 'd', 'top.txt'], 'marked by the file system: not walked into');
  let reads = 0;
  const stopped = await collect({ current: () => reads++ < 1 });
  assert.equal(stopped.length, 0, 'stops once no longer current');
});
