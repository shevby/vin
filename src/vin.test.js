const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');
const Handler = require('./handler');

class Zip extends Handler {
  /** @param {string[]} files */
  zip(files) {
    return `zipped ${files.length}`;
  }
}

test('registers a handler and resolves it and its sub-handlers by path', () => {
  const vin = new Vin();
  const main = new Handler('main');
  const left = main.add(new Handler('left'));
  vin.register(main);
  assert.equal(vin.resolve('main'), main);
  assert.equal(vin.resolve('main.left'), left);
  assert.throws(() => vin.resolve('nope.left'), /No handler "nope"/);
  assert.throws(() => vin.resolve('main.nope'), /No handler "main.nope"/);
});

test('rejects non-handlers, sub-handlers, and duplicate names', () => {
  const vin = new Vin();
  vin.register(new Handler('zip'));
  assert.throws(() => vin.register(new Handler('zip')), /already registered/);
  assert.throws(() => vin.register(/** @type {any} */ ({ name: 'fake' })), TypeError);
  const child = new Handler('main').add(new Handler('left'));
  assert.throws(() => vin.register(child), /"main.left" is a sub-handler/);
});

test('calls a handler method by its full path', async () => {
  const vin = new Vin();
  vin.register(new Zip('zip'));
  assert.equal(await vin.call('zip.zip', ['a', 'b']), 'zipped 2');
  await assert.rejects(vin.call('zip'), /names no method/);
  await assert.rejects(vin.call('zip.dispose'), /no callable method "dispose"/);
});

test('init and dispose cover every handler, disposing in reverse order', async () => {
  /** @type {string[]} */
  const events = [];
  class Tracked extends Handler {
    onInit() {
      events.push(`init ${this.name}`);
    }
    onDispose() {
      events.push(`dispose ${this.name}`);
    }
  }
  const vin = new Vin();
  vin.register(new Tracked('a'));
  vin.register(new Tracked('b'));
  await vin.init();
  await vin.dispose();
  assert.deepEqual(events, ['init a', 'init b', 'dispose b', 'dispose a']);
});
