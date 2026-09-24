const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { Paths, PathError, paths } = require('./paths');

const windows = new Paths({ platform: 'win32', home: 'c:\\Users\\me' });
const unix = new Paths({ platform: 'linux', home: '/home/me/' });

test('reads native, Git Bash, ~ and relative Windows paths into the native form', () => {
  const base = 'D:\\projects\\vin';
  /** @type {[string, string][]} */
  const cases = [
    ['C:\\Users\\me\\x', 'C:\\Users\\me\\x'],
    ['c:/Users//me/x/', 'C:\\Users\\me\\x'],
    ['"C:\\Program Files\\x"', 'C:\\Program Files\\x'],
    ['C:\\a\\..\\..\\b\\.', 'C:\\b'],
    ['C:\\', 'C:\\'],
    ['/c/Users/me', 'C:\\Users\\me'],
    ['/C', 'C:\\'],
    ['/d/', 'D:\\'],
    ['\\c\\Users', 'D:\\c\\Users'],
    ['/tmp', 'D:\\tmp'],
    ['/cd/x', 'D:\\cd\\x'],
    ['\\\\server\\share', '\\\\server\\share\\'],
    ['//server/share/dir/', '\\\\server\\share\\dir'],
    ['\\\\?\\C:\\very\\long', 'C:\\very\\long'],
    ['\\\\?\\UNC\\server\\share\\x', '\\\\server\\share\\x'],
    ['~', 'C:\\Users\\me'],
    ['~/x', 'C:\\Users\\me\\x'],
    ['~\\x', 'C:\\Users\\me\\x'],
    ['~x', 'D:\\projects\\vin\\~x'],
    ['src', 'D:\\projects\\vin\\src'],
    ['..\\..\\..', 'D:\\'],
    ['../x', 'D:\\projects\\x'],
    ['D:src', 'D:\\projects\\vin\\src'],
    ['d:', 'D:\\projects\\vin'],
    ['C:src', 'C:\\src'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(windows.resolve(input, base), expected, input);
  }
  assert.equal(windows.resolve('\\x', '\\\\server\\share\\dir'), '\\\\server\\share\\x', 'the root of the base');
  assert.equal(windows.home, 'C:\\Users\\me');
});

test('reads Unix paths; backslashes and drive letters are ordinary characters there', () => {
  /** @type {[string, string][]} */
  const cases = [
    ['/usr//lib/', '/usr/lib'],
    ['/a/../../b/.', '/b'],
    ['/', '/'],
    ['~', '/home/me'],
    ['~/x', '/home/me/x'],
    ['~x', '/srv/~x'],
    ['x', '/srv/x'],
    ['..', '/'],
    ['C:\\x', '/srv/C:\\x'],
    ['"q"', '/srv/"q"'],
    ['/c/x', '/c/x'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(unix.resolve(input, '/srv'), expected, input);
  }
  assert.equal(unix.home, '/home/me');
});

test('explains paths it can\'t read', () => {
  /** @type {[InstanceType<typeof Paths>, string, RegExp][]} */
  const cases = [
    [windows, '', /^Invalid path "": it is empty$/],
    [windows, '""', /it is empty/],
    [windows, 'C:\\a\0b', /NUL character/],
    [windows, 'C:\\a?b', /Windows names can't contain "\?"/],
    [windows, 'C:\\a:b', /Windows names can't contain ":"/],
    [windows, 'C:\\a\x01', /Windows names can't contain control character 1/],
    [windows, '"C:\\x', /Windows names can't contain """/],
    [windows, '\\\\server', /a UNC path needs a server and a share/],
    [windows, '//server/', /a UNC path needs a server and a share/],
    [windows, '\\\\.\\pipe\\x', /device paths/],
    [windows, '\\\\?\\Volume{1}\\x', /only a drive/],
    [windows, 'x', /it is relative, and there's no directory/],
    [windows, '\\x', /it has no drive/],
    [unix, 'x', /it is relative/],
    [unix, '/a\0', /NUL character/],
  ];
  for (const [rules, input, message] of cases) {
    assert.throws(() => rules.resolve(input), (error) => {
      assert.ok(error instanceof PathError, input);
      assert.equal(/** @type {InstanceType<typeof PathError>} */ (error).code, 'EPATH');
      assert.match(/** @type {Error} */ (error).message, message, input);
      return true;
    });
  }
  assert.throws(() => windows.resolve(/** @type {any} */ (5)), TypeError);
});

test('shows paths Unix-style, and reads them back', () => {
  /** @type {[InstanceType<typeof Paths>, string, string][]} */
  const cases = [
    [windows, 'C:\\Users\\me', '~'],
    [windows, 'C:\\users\\ME\\Documents\\a b', '~/Documents/a b'],
    [windows, 'C:\\Users\\meme', '/c/Users/meme'],
    [windows, 'C:\\Users', '/c/Users'],
    [windows, 'C:\\', '/c'],
    [windows, 'D:\\projects\\vin', '/d/projects/vin'],
    [windows, '\\\\server\\share\\', '//server/share'],
    [windows, '\\\\server\\share\\dir', '//server/share/dir'],
    [windows, '\\\\s\\share\\dir', '//s/share/dir'],
    [unix, '/home/me', '~'],
    [unix, '/home/me/x', '~/x'],
    [unix, '/home/meme', '/home/meme'],
    [unix, '/', '/'],
    [unix, '/srv/a\\b', '/srv/a\\b'],
  ];
  for (const [rules, path, shown] of cases) {
    assert.equal(rules.display(path), shown, path);
    assert.ok(rules.equals(rules.resolve(shown), path), `${shown} reads back`);
  }
  const rootHome = new Paths({ platform: 'linux', home: '/' });
  assert.equal(rootHome.display('/etc'), '/etc', 'a home at the root is never shown as ~');
});

test('parent, basename and join stop at roots and take one name', () => {
  assert.equal(windows.parent('C:\\Users\\me'), 'C:\\Users');
  assert.equal(windows.parent('C:\\Users'), 'C:\\');
  assert.equal(windows.parent('C:\\'), null);
  assert.equal(windows.parent('\\\\server\\share\\dir'), '\\\\server\\share\\');
  assert.equal(windows.parent('\\\\server\\share\\'), null);
  assert.equal(unix.parent('/usr'), '/');
  assert.equal(unix.parent('/'), null);

  assert.equal(windows.basename('C:\\Users\\me'), 'me');
  assert.equal(windows.basename('C:\\'), '');
  assert.equal(windows.basename('\\\\server\\share\\'), '');
  assert.equal(unix.basename('/'), '');

  assert.equal(windows.join('C:\\', 'x'), 'C:\\x');
  assert.equal(windows.join('\\\\server\\share\\', 'x'), '\\\\server\\share\\x');
  assert.equal(unix.join('/usr', 'a\\b'), '/usr/a\\b');
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a:b']) {
    assert.throws(() => windows.join('C:\\', name), /must be one name/, name);
  }
  assert.throws(() => unix.join('/', 'a/b'), /must be one name/);
});

test('converts paths to file: URIs and back', () => {
  /** @type {[InstanceType<typeof Paths>, string, string][]} */
  const cases = [
    [windows, 'C:\\', 'file:///C:/'],
    [windows, 'C:\\Program Files\\a#b%c', 'file:///C:/Program%20Files/a%23b%25c'],
    [windows, '\\\\server\\share\\x', 'file://server/share/x'],
    [unix, '/', 'file:///'],
    [unix, '/srv/a\\b c', 'file:///srv/a%5Cb%20c'],
  ];
  for (const [rules, path, uri] of cases) {
    assert.equal(rules.toUri(path), uri, path);
    assert.equal(rules.fromUri(uri), path, uri);
  }
  assert.equal(windows.fromUri('file:///c:/x/'), 'C:\\x', 'normalized as resolve() does');
  assert.throws(() => windows.fromUri('sftp://host/x'), /Invalid path "sftp:\/\/host\/x": it isn't a file: URI/);
  assert.throws(() => unix.fromUri('file://host/x'), (error) => error instanceof PathError);
});

test('shows a file: URI as its path, and any other URI as it is', () => {
  assert.equal(windows.displayUri('file:///C:/Program%20Files'), '/c/Program Files');
  assert.equal(unix.displayUri('file:///srv/a%20b'), '/srv/a b');
  assert.equal(windows.displayUri('sftp://host/x'), 'sftp://host/x');
  assert.equal(unix.displayUri('file://host/x'), 'file://host/x', "a path Unix can't have");
});

test('on Windows, the list of drives is file:/// and /, with each drive as its letter', () => {
  assert.equal(windows.drives, 'file:///');
  assert.equal(unix.drives, null);
  assert.equal(windows.displayUri('file:///'), '/');
  assert.equal(unix.displayUri('file:///'), '/');
  assert.equal(windows.fromUri('file:///c'), 'C:\\', 'an entry of the list');
  assert.equal(windows.fromUri('file:///d/a%20b'), 'D:\\a b');
  assert.throws(() => windows.fromUri('file:///'), (error) => error instanceof PathError);
  assert.equal(windows.driveName('C:\\'), 'c');
  assert.equal(windows.driveName('C:\\x'), null);
  assert.equal(windows.driveName('\\\\server\\share\\'), null);
  assert.equal(unix.driveName('/'), null);

  assert.equal(windows.resolveUri('/'), 'file:///', 'forward slashes, as Git Bash writes paths');
  assert.equal(windows.resolveUri('\\', 'file:///D:/x'), 'file:///D:/', 'a backslash keeps its native meaning');
  assert.equal(windows.resolveUri('c/Users', 'file:///'), 'file:///C:/Users', 'relative to the list: a drive');
  assert.equal(windows.resolveUri('D:\\x', 'file:///'), 'file:///D:/x');
  assert.equal(windows.resolveUri('~', 'file:///'), 'file:///C:/Users/me');
  assert.equal(windows.resolveUri('..', 'file:///C:/a/b'), 'file:///C:/a');
  assert.equal(unix.resolveUri('/'), 'file:///');
  assert.equal(unix.resolveUri('b', 'file:///srv/a'), 'file:///srv/a/b');
  assert.throws(() => unix.resolveUri('b', 'sftp://host/a'), /it is relative/, 'relative to a remote directory');
  assert.equal(unix.resolveUri('/b', 'sftp://host/a'), 'file:///b');
});

test('equals ignores case on Windows only', () => {
  assert.ok(windows.equals('C:\\Users', 'c:\\USERS'));
  assert.ok(!unix.equals('/Users', '/users'));
});

test("the default rules are this OS's, with the user's home", () => {
  assert.equal(paths.display(os.homedir()), '~');
  assert.equal(paths.resolve('~'), paths.home);
});
