const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { opener, launcher } = require('./open');

test('each OS has its launcher, taking the path as one argument, never through a shell', () => {
  const name = "a & b %PATH% ^!'$x `y.txt";
  assert.deepEqual(launcher(`C:\\x\\${name}`, 'win32').env, { VIN_OPEN: `C:\\x\\${name}` });
  assert.ok(launcher(`C:\\x\\${name}`, 'win32').args.every((arg) => !arg.includes(name)), 'not in the command line');
  assert.deepEqual(launcher(`/x/${name}`, 'darwin'), { file: 'open', args: [`/x/${name}`] });
  assert.deepEqual(launcher(`/x/${name}`, 'linux'), { file: 'xdg-open', args: [`/x/${name}`] });
});

test('a launcher that fails, or is missing, is an expected failure with its reason', { skip: process.platform !== 'win32' }, async () => {
  const missing = path.join(os.tmpdir(), 'vin-no-such-file.txt');
  await assert.rejects(opener.openWithDefaultApp(missing), (error) => {
    assert.equal(/** @type {any} */ (error).code, 'EFAIL');
    assert.match(/** @type {Error} */ (error).message, /^Can't open .*vin-no-such-file\.txt: Cannot find path/);
    return true;
  });
  // Linux's launcher, which Windows hasn't got.
  await assert.rejects(opener.openWithDefaultApp(missing, { platform: 'linux' }), /Can't open files: xdg-open isn't installed/);
});
