const test = require('node:test');
const assert = require('node:assert/strict');
const { describeError, isExpected, failure } = require('./errors');
const { fsError } = require('./fs/file-system');
const { Paths, PathError } = require('./paths');

const windows = new Paths({ platform: 'win32', home: 'C:\\Users\\me' });

/**
 * An error as Node's `fs` gives it.
 * @param {string} code
 * @param {string} message
 * @param {object} [where]
 */
const nodeError = (code, message, where) => Object.assign(new Error(`${code}: ${message}`), { code }, where);

test('file system errors show their reason and the paths, as vin shows paths', () => {
  /** @type {[unknown, string][]} */
  const cases = [
    [nodeError('ENOENT', "no such file or directory, open 'C:\\Users\\me\\x.txt'", { path: 'C:\\Users\\me\\x.txt' }), 'No such file or directory: ~/x.txt'],
    [nodeError('EACCES', 'permission denied', { path: 'D:\\secret' }), 'Permission denied: /d/secret'],
    [nodeError('EPERM', 'operation not permitted', { path: 'C:\\a', dest: 'C:\\b' }), 'Operation not permitted: /c/a → /c/b'],
    [fsError('EEXIST', 'Already exists', { path: 'C:\\Users\\me\\a', dest: 'C:\\Users\\me\\b' }), 'Already exists: ~/a → ~/b'],
    [fsError('EXDEV', "Can't copy between file systems yet", { path: 'file:///C:/a%20b', dest: 'sftp://host/x' }), "Can't copy between file systems yet: /c/a b → sftp://host/x"],
    [fsError('ENOSYS', "This file system can't copy yet"), "This file system can't copy yet"],
    [nodeError('EBUSY', 'resource busy or locked', { path: 'not a path?' }), 'Busy or locked by another program: not a path?'],
    [nodeError('ENOENT', 'no such file or directory'), 'No such file or directory'],
    [nodeError('ECONNREFUSED', 'connection refused'), 'Connection refused'],
  ];
  for (const [error, text] of cases) {
    assert.equal(describeError(error, windows), text);
    assert.ok(isExpected(error), text);
  }
});

test("vin's own failures are expected and keep their message; anything else is a bug", () => {
  assert.equal(describeError(new PathError('x', 'it is relative'), windows), 'Invalid path "x": it is relative');
  assert.ok(isExpected(new PathError('x', 'it is relative')));
  assert.equal(describeError(failure('Nothing to paste')), 'Nothing to paste');
  assert.ok(isExpected(failure('Nothing to paste')));
  assert.ok(isExpected(Object.assign(new Error('from a plugin'), { code: 'ENOENT' })), 'the code alone decides');

  const bug = new TypeError("Cannot read properties of undefined (reading 'x')");
  assert.ok(!isExpected(bug));
  assert.equal(describeError(bug), "Cannot read properties of undefined (reading 'x')");
  assert.ok(!isExpected(Object.assign(new Error('odd'), { code: 'ERR_ASSERTION' })));
  assert.ok(!isExpected(Object.assign(new Error('odd'), { code: 1 })));
  assert.equal(describeError('thrown string'), 'thrown string');
  assert.equal(describeError(undefined), 'undefined');
  assert.ok(!isExpected(null));
  assert.equal(describeError(new RangeError('')), 'RangeError');
});
