const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');
const Handler = require('./handler');
const { createInProcessTransport } = require('./transport');

/** @extends {Handler<{ cwd: string }>} */
class Pane extends Handler {
  onInit() {
    this.update({ cwd: '/' });
  }

  /** @param {string} dir */
  navigate(dir) {
    this.state.cwd = dir;
  }

  /** @param {{ n: number }} options */
  echo(options) {
    options.n++;
    return options;
  }

  open() {
    throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT', path: '/x' });
  }

  map() {
    return new Map();
  }
}

async function setup() {
  const vin = new Vin();
  const main = new Handler('main');
  main.add(new Pane('left'));
  vin.register(main);
  await vin.init();
  return { vin, transport: createInProcessTransport(vin) };
}

test('call runs a method by path and copies arguments and results as JSON', async () => {
  const { transport } = await setup();
  const options = { n: 1 };
  assert.deepEqual(await transport.call('main.left.echo', [options]), { n: 2 });
  assert.deepEqual(options, { n: 1 }, "the method got a copy, not the caller's object");
  assert.equal(await transport.call('main.left.navigate', ['/tmp']), null, 'no result is null, as over JSON-RPC');
});

test('call refuses what JSON-RPC could not carry', async () => {
  const { transport } = await setup();
  await assert.rejects(transport.call('main.left.navigate', /** @type {any} */ ([undefined])), /"main.left.navigate" value at "args.0" is undefined/);
  await assert.rejects(transport.call('main.left.map', []), /"main.left.map" value at "result" is a Map object/);
});

test('a failed call keeps only the message and code, with the original as cause', async () => {
  const { transport } = await setup();
  await assert.rejects(transport.call('main.left.open', []), (/** @type {any} */ error) => {
    assert.equal(error.message, 'ENOENT: no such file');
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.path, undefined);
    assert.equal(error.cause.path, '/x');
    return true;
  });
  await assert.rejects(transport.call('main.left.dispose', []), /no callable method "dispose"/);
});

test('subscribe follows a handler by path', async () => {
  const { transport } = await setup();
  /** @type {unknown[]} */
  const messages = [];
  const unsubscribe = transport.subscribe('main.left', (message) => messages.push(message));
  await transport.call('main.left.navigate', ['/tmp']);
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();
  assert.deepEqual(messages, [
    { type: 'replace', state: { cwd: '/' } },
    { type: 'patch', patches: [{ op: 'set', path: ['cwd'], value: '/tmp' }] },
  ]);
  assert.throws(() => transport.subscribe('main.nope', () => {}), /No handler "main.nope"/);
});
