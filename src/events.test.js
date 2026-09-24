const test = require('node:test');
const assert = require('node:assert/strict');
const { EventBus } = require('./events');
const Handler = require('./handler');
const Vin = require('./vin');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('events are delivered a microtask later, with a frozen copy of the payload', async () => {
  const bus = new EventBus();
  /** @type {unknown[]} */
  const received = [];
  bus.on('main.left.changed', (payload, event) => received.push(payload, event));
  const payload = { cwd: '/tmp', rows: [1] };
  bus.emit('main.left.changed', payload, 'main.left');
  payload.cwd = '/changed';
  assert.equal(received.length, 0, 'not delivered synchronously');

  await tick();
  assert.deepEqual(received, [{ cwd: '/tmp', rows: [1] }, { name: 'main.left.changed', source: 'main.left' }]);
  const [copy] = /** @type {any[]} */ (received);
  assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.rows));
});

test('payloads must be JSON data; names must be a handler path plus an event', () => {
  const bus = new EventBus();
  assert.throws(() => bus.emit('a.b', { when: new Date() }, 'a'), /Event "a.b" payload value at "when" is a Date object/);
  assert.throws(() => bus.on('changed', () => {}), /expected "<handler path>.<event>"/);
  assert.throws(() => bus.on('a..b', () => {}), /Invalid event name/);
});

test('a failing listener is isolated; unsubscribing during delivery skips the listener', async () => {
  const bus = new EventBus();
  /** @type {string[]} */
  const calls = [];
  bus.on('a.x', () => {
    calls.push('throws');
    throw new Error('boom');
  });
  bus.on('a.x', async () => {
    calls.push('rejects');
    throw new Error('async boom');
  });
  const offLast = bus.on('a.x', () => calls.push('last'));
  bus.on('a.x', () => offLast());
  bus.emit('a.x', null, 'a');
  await tick();
  assert.deepEqual(calls, ['throws', 'rejects', 'last']);

  calls.length = 0;
  bus.emit('a.x', null, 'a');
  await tick();
  assert.deepEqual(calls, ['throws', 'rejects'], 'the removed listener stays removed');
});

test('handlers emit under their own path and stop listening when disposed', async () => {
  class Pane extends Handler {
    /** @param {string} dir */
    navigate(dir) {
      this.emit('changed', { cwd: dir });
    }
  }
  /** @type {unknown[]} */
  const heard = [];
  class Status extends Handler {
    onInit() {
      this.on('main.left.changed', (payload, { source }) => heard.push([source, payload]));
    }
  }

  const vin = new Vin();
  const main = new Handler('main');
  main.add(new Pane('left'));
  const status = main.add(new Status('status'));
  vin.register(main);
  await vin.init();

  await vin.call('main.left.navigate', '/tmp');
  await tick();
  assert.deepEqual(heard, [['main.left', { cwd: '/tmp' }]]);

  await main.remove('status');
  await vin.call('main.left.navigate', '/var');
  await tick();
  assert.equal(heard.length, 1, 'a disposed handler hears nothing more');
  assert.throws(() => status.on('main.left.changed', () => {}), /Disposed handler "status"/);
});

test('events need a registered tree and a plain event name', () => {
  const orphan = new Handler('orphan');
  assert.throws(() => orphan.emit('x'), /"orphan" can't emit events: its top-level handler isn't registered/);
  assert.throws(() => orphan.on('a.b', () => {}), /can't listen for events/);

  const vin = new Vin();
  const main = new Handler('main');
  vin.register(main);
  assert.throws(() => main.emit('a.b'), /Invalid event name "a.b"/);
  assert.doesNotThrow(() => main.add(new Handler('left')).emit('ok'), 'sub-handlers reach the bus through their root');
});
