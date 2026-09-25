const test = require('node:test');
const assert = require('node:assert/strict');
const { comparator, isHidden, describeSort } = require('./sorting');

/**
 * @param {string} name
 * @param {Partial<import('./sorting').Sortable>} [fields]
 * @returns {import('./sorting').Sortable}
 */
const entry = (name, fields = {}) => ({ name, type: 'file', size: null, mtime: null, ...fields });

const entries = [
  entry('src', { type: 'directory', size: 4096, mtime: 5 }),
  entry('b.txt', { size: 30, mtime: 1 }),
  entry('a.md', { size: 20, mtime: 3 }),
  entry('file10', { size: 10, mtime: 2 }),
  entry('file2', { size: 10, mtime: 4 }),
  entry('Docs', { type: 'directory', size: 0, mtime: 0 }),
];

/**
 * @param {Partial<import('./sorting').Sort>} sort
 * @param {import('./sorting').Sortable[]} [list]
 */
const order = (sort, list = entries) => [...list].sort(comparator({ by: 'name', reverse: false, directoriesFirst: true, ...sort })).map((one) => one.name);

test('by name, in natural order, directories first unless not', () => {
  assert.deepEqual(order({}), ['Docs', 'src', 'a.md', 'b.txt', 'file2', 'file10']);
  assert.deepEqual(order({ reverse: true }), ['src', 'Docs', 'file10', 'file2', 'b.txt', 'a.md']);
  assert.deepEqual(order({ directoriesFirst: false }), ['a.md', 'b.txt', 'Docs', 'file2', 'file10', 'src']);
});

test('by extension, size, or modified time; equal ones by name', () => {
  assert.deepEqual(order({ by: 'extension' }), ['Docs', 'src', 'file2', 'file10', 'a.md', 'b.txt']);
  assert.deepEqual(order({ by: 'size' }), ['Docs', 'src', 'file2', 'file10', 'a.md', 'b.txt'], 'a directory counts as nothing');
  assert.deepEqual(order({ by: 'size', reverse: true }), ['src', 'Docs', 'b.txt', 'a.md', 'file10', 'file2']);
  assert.deepEqual(order({ by: 'modified', reverse: true, directoriesFirst: false }), ['src', 'file2', 'a.md', 'file10', 'b.txt', 'Docs']);
});

test('a size or time not known yet goes last, however it is reversed', () => {
  const list = [entry('x'), entry('y', { size: 1 }), entry('w'), entry('z', { size: 2 })];
  assert.deepEqual(order({ by: 'size' }, list), ['y', 'z', 'w', 'x']);
  assert.deepEqual(order({ by: 'size', reverse: true }, list), ['z', 'y', 'w', 'x']);
});

test('hidden: a name starting with ., or marked so by the file system', () => {
  assert.equal(isHidden({ name: '.git' }), true);
  assert.equal(isHidden({ name: 'pagefile.sys', hidden: true }), true);
  assert.equal(isHidden({ name: 'a.b' }), false);
});

test('a sort in words', () => {
  assert.equal(describeSort({ by: 'name', reverse: false }), 'name');
  assert.equal(describeSort({ by: 'extension', reverse: true }), 'extension, Z to A');
  assert.equal(describeSort({ by: 'size', reverse: true }), 'size, largest first');
  assert.equal(describeSort({ by: 'modified', reverse: false }), 'modified, oldest first');
});
