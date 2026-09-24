import test from 'node:test';
import assert from 'node:assert/strict';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import Vin from '../../src/vin.js';
import Handler from '../../src/handler.js';
import { createInProcessTransport } from '../../src/transport.js';
import { useSelector } from './common/store/index.js';
import { connect, disconnect, init } from './handler.js';

/** @typedef {import('../../src/transport.js').Transport} Transport */

/** Lets the per-tick state flush and React's re-render run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** @extends {Handler<{ cwd: string }>} */
class Pane extends Handler {
  onInit() {
    this.update({ cwd: '/' });
  }

  /** @param {string} dir */
  navigate(dir) {
    this.state.cwd = dir;
    return `at ${dir}`;
  }
}

async function setup() {
  const vin = new Vin();
  const main = new Handler('main');
  main.add(new Pane('left'));
  vin.register(main);
  await vin.init();
  connect(createInProcessTransport(vin));
  return vin;
}

test('a handle chains names into paths and calls methods through the transport', async (t) => {
  await setup();
  t.after(disconnect);
  const main = init('main');
  assert.equal(main.left, init('main.left'), 'handles are cached by path');
  assert.equal(main.left.path, 'main.left');
  assert.equal(main.left.navigate.path, 'main.left.navigate');
  assert.equal(await main.left.navigate('/tmp'), 'at /tmp');
  await assert.rejects(main.left.missing(), /no callable method "missing"/);
  assert.equal(await main, main, "a handle isn't thenable");
  assert.equal(typeof main.toString, 'function');
});

test('a component reads handler state through the handle store and follows its changes', async (t) => {
  await setup();
  t.after(disconnect);
  const left = init('main.left');
  const Cwd = () => <Text>cwd={useSelector(left.store, (s) => s.cwd)}</Text>;
  const { lastFrame, unmount } = render(<Cwd />);
  assert.match(lastFrame() ?? '', /cwd=\//, 'the first render already has the state');
  assert.equal(left.store, init('main.left').store, 'one store per handler');

  await left.navigate('/tmp');
  await settle();
  assert.match(lastFrame() ?? '', /cwd=\/tmp/);
  unmount();
});

test('a store that falls out of sync logs it and resubscribes from a fresh snapshot', async (t) => {
  /** @type {((message: any) => void)[]} */
  const listeners = [];
  let unsubscribed = 0;
  /** @type {Transport} */
  const transport = {
    call: async () => null,
    subscribe(_handler, listener) {
      listeners.push(listener);
      listener({ type: 'replace', state: { n: listeners.length } });
      return () => unsubscribed++;
    },
  };
  connect(transport);
  t.after(disconnect);
  const { store } = init('x');
  assert.deepEqual(store.getSnapshot(), { n: 1 });

  listeners[0]({ type: 'patch', patches: [{ op: 'set', path: ['n', 'deep'], value: 1 }] });
  await settle();
  assert.equal(unsubscribed, 1);
  assert.equal(listeners.length, 2, 'subscribed again');
  assert.deepEqual(store.getSnapshot(), { n: 2 });
});

test('handles need a connection, and disconnect stops following state', async () => {
  disconnect();
  await assert.rejects(async () => init('main').left.navigate('/'), /not connected/);

  const vin = await setup();
  const { store } = init('main.left');
  disconnect();
  await vin.call('main.left.navigate', '/tmp');
  await settle();
  assert.deepEqual(store.getSnapshot(), { cwd: '/' });
});
