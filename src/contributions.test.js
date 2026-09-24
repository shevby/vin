const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');
const Handler = require('./handler');
const { Registry } = require('./contributions');
const { createInProcessTransport } = require('./transport');

class Pane extends Handler {
  static kind = 'pane';
  static contributes = {
    commands: [
      { method: 'down', title: 'Cursor down' },
      { method: 'info', title: 'Info', description: 'Where the pane is', cli: true },
    ],
    keybindings: [{ key: 'j', command: 'pane.down' }],
    contextMenu: [{ command: 'pane.info', group: 'details' }],
  };

  down() {
    return `${this.path} down`;
  }

  /** @param {string} [suffix] */
  info(suffix = '') {
    return `${this.path}${suffix}`;
  }
}

class Main extends Handler {
  static contributes = { commands: [{ method: 'swap', title: 'Swap panes' }] };

  constructor() {
    super('main');
    this.add(new Pane('left'));
    this.add(new Pane('right'));
  }

  swap() {
    return 'swapped';
  }
}

async function setup() {
  const vin = new Vin();
  vin.register(new Main());
  await vin.init();
  return vin;
}

test('a class contributes once for all its instances, normalized, until the last one is disposed', async () => {
  const vin = await setup();
  assert.deepEqual(vin.registry.get('commands').map((c) => c.id), ['main.swap', 'pane.down', 'pane.info']);
  assert.deepEqual(vin.registry.command('pane.info'), {
    id: 'pane.info', kind: 'pane', method: 'info', title: 'Info', description: 'Where the pane is',
    tui: true, cli: true, source: 'pane',
  });
  assert.deepEqual(vin.registry.get('keybindings'), [
    { key: 'j', keys: ['j'], command: 'pane.down', args: [], mode: 'normal', source: 'pane', user: false },
  ]);
  assert.deepEqual(vin.registry.get('contextMenu'), [
    { command: 'pane.info', title: null, group: 'details', order: 0, args: [], source: 'pane' },
  ]);
  assert.deepEqual(vin.registry.instances('pane').map((h) => h.path), ['main.left', 'main.right']);

  const main = /** @type {Main} */ (vin.resolve('main'));
  await main.remove('left');
  assert.equal(vin.registry.command('pane.down')?.id, 'pane.down', 'right is still there');
  await main.remove('right');
  assert.equal(vin.registry.command('pane.down'), undefined);
  assert.deepEqual(vin.registry.get('keybindings'), []);
});

test('a command runs on the focused instance of its kind, or the only one', async () => {
  const vin = await setup();
  assert.equal(await vin.execute('pane.down', { focus: 'main.right' }), 'main.right down');
  assert.equal(await vin.execute('pane.info', { focus: 'main.left', args: ['!'] }), 'main.left!');
  assert.equal(await vin.execute('main.swap', { focus: 'main.left' }), 'swapped', 'an ancestor of the focus');
  assert.equal(await vin.execute('main.swap'), 'swapped', 'the only main, without focus');
  await assert.rejects(vin.execute('pane.down'), /needs a focused "pane"; there are 2: main.left, main.right/);
  await assert.rejects(vin.execute('pane.nope'), /Unknown command "pane.nope"/);
  await assert.rejects(vin.execute('pane.down', { focus: 'main.left', surface: 'cli' }), /isn't available from the CLI/);
  assert.equal(await vin.execute('pane.info', { focus: 'main.left', surface: 'cli' }), 'main.left');
});

test('the core handler mirrors the registry and runs commands for the UI', async () => {
  const vin = await setup();
  const transport = createInProcessTransport(vin);
  /** @type {any} */
  let state;
  transport.subscribe('core', (message) => {
    assert.equal(message.type, 'replace');
    state = message.state;
  });
  assert.deepEqual(state.contributions.commands.map((/** @type {any} */ c) => c.id), ['main.swap', 'pane.down', 'pane.info']);
  assert.equal(await transport.call('core.execute', ['pane.down', 'main.left', []]), 'main.left down');
});

test('contributions are checked, with the source and item in the error, and nothing half-registered', async () => {
  /**
   * @param {object} contributes
   * @param {RegExp} message
   */
  const rejects = async (contributes, message) => {
    class Bad extends Pane {
      static kind = 'bad';
      static contributes = /** @type {any} */ (contributes);
    }
    const vin = new Vin();
    vin.register(new Bad('bad'));
    await assert.rejects(vin.init(), message);
    assert.deepEqual(vin.registry.get('commands'), [], 'nothing left behind');
    assert.deepEqual(vin.registry.get('keybindings'), []);
  };
  await rejects({ commands: [{ method: 'down' }] }, /commands\[0\] from "bad" needs "title"/);
  await rejects({ commands: [{ method: 'down', title: 'x', titel: 'y' }] }, /unknown field "titel"/);
  await rejects({ commands: [{ method: 'dispose', title: 'x' }] }, /"dispose" isn't a callable method of "bad"/);
  await rejects({ commands: [{ method: 'down', title: 'x', tui: false }] }, /neither the TUI nor the CLI/);
  await rejects({ commands: [{ method: 'down', title: 1 }] }, /"title" must be a string/);
  await rejects({ menus: [] }, /unknown extension point "menus"; known: commands, keybindings, contextMenu/);
  await rejects(
    { commands: [{ method: 'down', title: 'x' }], keybindings: [{ key: 'j', command: 'down' }] },
    /keybindings\[0\] from "bad": command "down" isn't a command id/,
  );
  await rejects({ keybindings: [{ key: 'j', command: 'bad.down', args: [undefined] }] }, /"args.0" is undefined/);
});

test('a kind belongs to one class', async () => {
  class A extends Handler {
    static kind = 'same';
  }
  class B extends Handler {
    static kind = 'same';
  }
  const vin = new Vin();
  const root = new Handler('root');
  root.add(new A('a'));
  root.add(new B('b'));
  vin.register(root);
  await assert.rejects(vin.init(), /"root.b" \(B\) has kind "same", which "root.a" \(A\) already uses; give one of the classes its own static kind/);
});

test('the registry can be extended with new points, and ids stay unique within a point', () => {
  const registry = new Registry();
  /** @type {string[]} */
  const changes = [];
  registry.subscribe((point) => changes.push(point));
  registry.definePoint('statusItems', (item, { source }) => ({ id: `${source}.${item}`, source }));
  const release = registry.contribute('statusItems', ['clock'], { source: 'plugin' });
  assert.throws(() => registry.contribute('statusItems', ['clock'], { source: 'plugin' }), /statusItems "plugin.clock" from "plugin" is already contributed by "plugin"/);
  assert.deepEqual(registry.get('statusItems'), [{ id: 'plugin.clock', source: 'plugin' }]);
  release();
  release();
  assert.deepEqual(registry.get('statusItems'), []);
  assert.deepEqual(changes, ['statusItems', 'statusItems', 'statusItems']);
  assert.throws(() => registry.definePoint('commands', () => ({})), /already defined/);
});
