const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { Clipboard, system, writers, parsePaths } = require('./clipboard');
const { paths } = require('./paths');
const { failure } = require('./errors');

test('each OS has its clipboard writers, taking the text on stdin', () => {
  assert.deepEqual(writers('win32', {}).map((writer) => writer.file), ['powershell.exe']);
  assert.deepEqual(writers('darwin', {}).map((writer) => writer.file), ['pbcopy']);
  assert.deepEqual(writers('linux', {}).map((writer) => writer.file), ['xclip', 'xsel']);
  assert.deepEqual(writers('linux', { WAYLAND_DISPLAY: 'wayland-0' }).map((writer) => writer.file), ['wl-copy', 'xclip', 'xsel']);
  assert.ok(writers('win32', {})[0].args.every((arg) => !arg.includes('%')), 'no text in the command line');
});

test('pasted text is a list of paths if every line is an absolute path or a URI', () => {
  const home = paths.home;
  const file = paths.toUri(`${home}${home.includes('\\') ? '\\' : '/'}x y.txt`);
  assert.deepEqual(parsePaths(`${paths.fromUri(file)}\r\n\n"${home}"\r`), [file, paths.toUri(home)]);
  assert.deepEqual(parsePaths('sftp://host/a'), ['sftp://host/a']);
  assert.equal(parsePaths('relative/path'), null);
  assert.equal(parsePaths('hello world'), null);
  assert.equal(parsePaths(' \n '), null);
});

test('the clipboard holds entries, puts their paths on the OS clipboard, and recognizes them pasted back', async (t) => {
  /** @type {string[]} */
  const written = [];
  t.mock.method(system, 'writeText', async (/** @type {string} */ text) => {
    written.push(text);
  });
  const clipboard = new Clipboard({ report: () => assert.fail('nothing fails') });
  const uris = [paths.toUri(`${paths.home}/a`), paths.toUri(`${paths.home}/b`)];
  clipboard.set('cut', uris);
  assert.deepEqual(clipboard.content, { mode: 'cut', uris });
  assert.deepEqual(written, [uris.map((uri) => paths.fromUri(uri)).join(os.EOL)]);
  // Pasted back through a terminal, which may turn line breaks into carriage returns.
  assert.deepEqual(clipboard.recognize(written[0].replace(/\r?\n/g, '\r')), { mode: 'cut', uris });
  assert.deepEqual(clipboard.recognize(paths.fromUri(uris[0])), { mode: 'copy', uris: [uris[0]] }, 'other paths are copied');
  assert.equal(clipboard.recognize('not paths'), null);
  clipboard.clear();
  assert.equal(clipboard.content, null);
});

test('a failure to write the OS clipboard is reported once, then only logged', async (t) => {
  t.mock.method(system, 'writeText', async () => {
    throw failure("Can't put paths on the clipboard: install xclip or xsel");
  });
  /** @type {unknown[]} */
  const reported = [];
  const clipboard = new Clipboard({ report: (error) => reported.push(error) });
  clipboard.set('copy', [paths.toUri(paths.home)]);
  clipboard.set('copy', [paths.toUri(paths.home)]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]), /install xclip or xsel/);
  assert.deepEqual(clipboard.content, { mode: 'copy', uris: [paths.toUri(paths.home)] }, "vin's clipboard works anyway");
});
