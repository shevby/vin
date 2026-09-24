const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { failure } = require('./errors');
const Handler = require('./handler');
const { Messages, catchUncaught } = require('./messages');
const { Paths } = require('./paths');
const Vin = require('./vin');

const tick = () => new Promise((resolve) => setImmediate(resolve));

const windows = new Paths({ platform: 'win32', home: 'C:\\Users\\me' });

/**
 * A logger that remembers what it was given.
 * @param {string | null} [file]
 */
function fakeLog(file = 'C:\\Users\\me\\vin\\vin.log') {
  /** @type {[string, unknown[]][]} */
  const lines = [];
  /** @param {string} level */
  const writer = (level) => (/** @type {unknown[]} */ ...args) => lines.push([level, args]);
  return { lines, debug: writer('debug'), info: writer('info'), warn: writer('warn'), error: writer('error'), file };
}

test('shows messages until cleared, counting repeats, and keeps the latest 50', () => {
  const messages = new Messages({ paths: windows, log: fakeLog() });
  let changes = 0;
  const unsubscribe = messages.subscribe(() => changes++);

  messages.show('Copied');
  messages.show('Denied', 'error');
  messages.show('Denied', 'error');
  messages.show('Denied', 'warning');
  assert.deepEqual(messages.list, [
    { id: 1, level: 'info', text: 'Copied', count: 1 },
    { id: 3, level: 'error', text: 'Denied', count: 2 },
    { id: 4, level: 'warning', text: 'Denied', count: 1 },
  ]);
  assert.equal(changes, 4);

  messages.clear(3);
  assert.deepEqual(messages.list.map((message) => message.id), [4], 'ones after upTo stay');
  messages.clear();
  messages.clear();
  assert.equal(messages.list.length, 0);
  assert.equal(changes, 6, 'clearing nothing changes nothing');

  for (let i = 0; i < 60; i++) {
    messages.show(`m${i}`);
  }
  assert.equal(messages.list.length, 50);
  assert.equal(messages.list[0].text, 'm10');

  unsubscribe();
  messages.show('unheard');
  assert.equal(changes, 66);

  messages.list[0].text = 'changed';
  assert.equal(messages.list[0].text, 'm11', 'list is a copy');
  assert.throws(() => messages.show(''), TypeError);
  assert.throws(() => messages.show('x', /** @type {any} */ ('fatal')), /Invalid message level "fatal"/);
});

test('reports expected failures in words, and bugs as unexpected, logged with their context', () => {
  const log = fakeLog();
  const messages = new Messages({ paths: windows, log });
  const denied = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\me\\x'"), { code: 'EACCES', path: 'C:\\Users\\me\\x' });
  messages.report(denied, 'Opening failed');
  const bug = new TypeError('x is not a function');
  messages.report(bug);

  assert.deepEqual(messages.list.map(({ level, text }) => ({ level, text })), [
    { level: 'error', text: 'Permission denied: ~/x' },
    { level: 'error', text: 'Unexpected error: x is not a function — details in ~/vin/vin.log' },
  ]);
  assert.deepEqual(log.lines, [
    ['debug', ['Opening failed:', denied]],
    ['error', ['An operation failed:', bug]],
  ]);

  const unlogged = new Messages({ paths: windows, log: fakeLog(null) });
  unlogged.report(bug);
  assert.equal(unlogged.list[0].text, 'Unexpected error: x is not a function', 'no log to point to');
});

test('catchUncaught reports uncaught exceptions and unhandled rejections until released', () => {
  const messages = new Messages({ paths: windows, log: fakeLog(null) });
  // Not `process`: the test runner listens there too, and fails the test.
  const target = new EventEmitter();
  const release = catchUncaught(messages, target);
  target.emit('uncaughtException', new Error('thrown'), 'uncaughtException');
  target.emit('unhandledRejection', Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' }), Promise.resolve());
  release();
  assert.deepEqual(messages.list.map((message) => message.text), ['Unexpected error: thrown', 'Gone']);
  assert.equal(target.listenerCount('uncaughtException') + target.listenerCount('unhandledRejection'), 0);

  const broken = /** @type {any} */ ({ report: () => { throw new Error('report failed'); } });
  catchUncaught(broken, target);
  assert.doesNotThrow(() => target.emit('uncaughtException', new Error('x')), 'a failing report never escapes');
});

test('vin shows what fails in commands run by keys and in event listeners, and what handlers report', async () => {
  class Files extends Handler {
    static contributes = {
      commands: [{ method: 'open', title: 'Open' }, { method: 'crash', title: 'Crash' }],
      keybindings: [{ key: 'o', command: 'files.open' }, { key: 'c', command: 'files.crash' }],
    };

    async open() {
      const file = path.join(os.homedir(), 'x');
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT', path: file });
    }

    crash() {
      throw new TypeError('crash is broken');
    }
  }
  const vin = new Vin();
  const files = new Files('files');
  vin.register(files);
  await vin.init();
  await vin.openWindow('files');
  const core = /** @type {InstanceType<typeof import('./handlers/core/core')>} */ (vin.resolve('core'));
  const shown = () => core.state.messages.map(({ level, text, count }) => `${level}: ${text}${count > 1 ? ` ×${count}` : ''}`);

  await vin.call('core.press', 'o');
  await tick();
  await vin.call('core.press', 'o');
  await tick();
  assert.deepEqual(shown(), ['error: No such file or directory: ~/x'], 'a key clears what was shown, then its command fails anew');

  await vin.call('core.press', 'c');
  await tick();
  assert.deepEqual(shown(), ['error: Unexpected error: crash is broken']);

  files.on('files.changed', () => {
    throw failure('Refresh gave up');
  });
  files.emit('changed', null);
  await tick();
  files.notify('Copied 3 files');
  files.report(failure('Refresh gave up'));
  assert.deepEqual(shown(), [
    'error: Unexpected error: crash is broken',
    'error: Refresh gave up',
    'info: Copied 3 files',
    'error: Refresh gave up',
  ]);

  const [, second] = core.state.messages;
  await vin.call('core.clearMessages', second.id);
  assert.deepEqual(shown(), ['info: Copied 3 files', 'error: Refresh gave up'], 'a popup dismissed keeps what came after it');
  await assert.rejects(vin.call('core.clearMessages', 'all'), TypeError);
  await vin.call('core.clearMessages');
  assert.deepEqual(shown(), []);

  assert.throws(() => new Files('orphan').notify('x'), /Handler "orphan" can't show messages/);
  await vin.dispose();
});
