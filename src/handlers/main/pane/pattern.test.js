const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPattern, expand, extension } = require('./pattern');

/**
 * The names a pattern gives entries named `f0.mkv`, `f1.mkv`, ….
 * @param {string} pattern
 * @param {number} count
 */
const names = (pattern, count) => Array.from({ length: count }, (_, index) => expand(pattern, { index, count, name: `f${index}.mkv`, directory: false }));

test('$n counts from 1 and $i from 0, zero-padded to the digits of how many there are', () => {
  assert.deepEqual(names('Attack_on_titan_s1e$n$e', 3), ['Attack_on_titan_s1e1.mkv', 'Attack_on_titan_s1e2.mkv', 'Attack_on_titan_s1e3.mkv']);
  assert.deepEqual(names('e$i', 3), ['e0', 'e1', 'e2']);
  const ninetyNine = names('$n', 99);
  assert.deepEqual([ninetyNine[0], ninetyNine[98]], ['01', '99']);
  const hundred = names('$n.$i', 100);
  assert.deepEqual([hundred[0], hundred[99]], ['001.000', '100.099']);
});

test('$e is the extension, if any; $$ is $', () => {
  assert.equal(expand('x$e', { index: 0, count: 2, name: 'a.tar.gz', directory: false }), 'x.gz');
  assert.equal(expand('x$e', { index: 0, count: 2, name: 'v1.0', directory: true }), 'x', 'a directory has none');
  assert.equal(expand('x$e', { index: 0, count: 2, name: '.bashrc', directory: false }), 'x');
  assert.equal(expand('$$n$n', { index: 0, count: 2, name: 'a', directory: false }), '$n1');
  assert.equal(extension('notes.txt', false), '.txt');
});

test('a pattern needs $n or $i for two entries or more, and no unknown tokens', () => {
  assert.equal(checkPattern('show_$n.mkv', 24), null);
  assert.equal(checkPattern('show_$i', 2), null);
  assert.match(checkPattern('show.mkv', 2) ?? '', /\$n or \$i/);
  assert.match(checkPattern('show_$x$n', 2) ?? '', /^\$x isn't a token/);
  assert.match(checkPattern('show$n$', 2) ?? '', /^A \$ at the end isn't a token/);
  assert.equal(checkPattern('$$n', 2), 'Put $n or $i in it, so the names differ', '$$n is a $ and an n');
});
