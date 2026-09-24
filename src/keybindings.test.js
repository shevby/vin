const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');
const Handler = require('./handler');

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** @type {string[]} */
let calls = [];

/** @extends {Handler<{ mode: string }>} */
class Pane extends Handler {
  static kind = 'pane';
  static contributes = {
    commands: [
      { method: 'down', title: 'Down' },
      { method: 'top', title: 'Top' },
      { method: 'visual', title: 'Visual mode' },
      { method: 'mark', title: 'Mark' },
    ],
    keybindings: [
      { key: 'j', command: 'pane.down' },
      { key: 'g g', command: 'pane.top' },
      { key: 'v', command: 'pane.visual' },
      { key: 'j', command: 'pane.mark', mode: 'visual', args: ['down'] },
    ],
  };

  onInit() {
    this.update({ mode: 'normal' });
  }

  down() {
    calls.push(`${this.path} down`);
  }

  top() {
    calls.push(`${this.path} top`);
  }

  visual() {
    this.state.mode = 'visual';
  }

  /** @param {string} direction */
  mark(direction) {
    calls.push(`${this.path} mark ${direction}`);
  }
}

class Main extends Handler {
  static contributes = {
    commands: [{ method: 'swap', title: 'Swap' }, { method: 'down', title: 'Main down' }],
    keybindings: [{ key: 'tab', command: 'main.swap' }, { key: 'j', command: 'main.down' }],
  };

  constructor() {
    super('main');
    this.add(new Pane('left'));
    this.add(new Pane('right'));
  }

  swap() {
    calls.push('swap');
  }

  down() {
    calls.push('main down');
  }
}

async function setup() {
  calls = [];
  const vin = new Vin();
  vin.register(new Main());
  await vin.init();
  await vin.openWindow('main');
  /**
   * Focuses a handler of the main window, then presses keys.
   * @param {string} chords
   * @param {string} focus
   */
  const press = async (chords, focus) => {
    vin.resolve(focus).focus();
    /** @type {unknown[]} */
    const used = [];
    for (const chord of chords.split(' ')) {
      used.push(await vin.call('core.press', chord));
    }
    await tick();
    return used;
  };
  return { vin, press };
}

test('a key runs its command on the focused window, shadowing bindings around it', async () => {
  const { press } = await setup();
  await press('j', 'main.right');
  await press('tab', 'main.right');
  await press('j', 'main');
  assert.deepEqual(calls, ['main.right down', 'swap', 'main down']);
});

test('with no window open, only core bindings apply', async () => {
  calls = [];
  const vin = new Vin();
  vin.register(new Main());
  await vin.init();
  assert.equal(await vin.call('core.press', 'j'), false);
  assert.equal(await vin.call('core.press', 'escape'), true);
});

test('sequences show their pending keys in core state', async () => {
  const { vin, press } = await setup();
  /** @type {string[]} */
  const pending = [];
  vin.resolve('core').subscribeState((message) => {
    if (message.type === 'patch') {
      for (const patch of message.patches) {
        if (patch.path[0] === 'pendingKeys' && patch.op === 'set') {
          pending.push(/** @type {string} */ (patch.value));
        }
      }
    }
  });
  await press('g', 'main.left');
  await press('g', 'main.left');
  assert.deepEqual(calls, ['main.left top']);
  assert.deepEqual(pending, ['g', '']);
});

test("bindings follow the target window's mode", async () => {
  const { press } = await setup();
  await press('v', 'main.left');
  await press('j', 'main.left');
  await press('j', 'main.right');
  assert.deepEqual(calls, ['main.left mark down', 'main.right down']);
});

test('user config adds bindings after the defaults and removes them with -command', async () => {
  const { vin, press } = await setup();
  vin.registry.contribute(
    'keybindings',
    [
      { key: 'J', command: 'pane.down' },
      { command: '-pane.top' },
      { key: 'j', command: '-pane.down' },
      { key: 'ctrl+w w', command: 'main.swap' },
    ],
    { source: 'config', user: true },
  );
  assert.deepEqual(
    vin.registry.get('keybindings').map((b) => `${b.key} ${b.command}`),
    ['escape core.closeWindow', 'tab main.swap', 'j main.down', 'v pane.visual', 'j pane.mark', 'shift+j pane.down', 'ctrl+w w main.swap'],
  );
  await press('shift+j', 'main.left');
  await press('j', 'main.left');
  await press('g g', 'main.left');
  await press('ctrl+w w', 'main.left');
  assert.deepEqual(calls, ['main.left down', 'main down', 'swap']);
});

test('only user config can remove bindings, and chords must be canonical', async () => {
  const { vin } = await setup();
  assert.throws(
    () => vin.registry.contribute('keybindings', [{ command: '-pane.down' }], { source: 'plugin' }),
    /only user config can remove keybindings/,
  );
  assert.throws(
    () => vin.registry.contribute('keybindings', [{ key: 'ctrl', command: 'pane.down' }], { source: 'plugin' }),
    /keybindings\[0\] from "plugin": Key "ctrl": "ctrl" needs a key after it/,
  );
  await assert.rejects(vin.call('core.press', 'G'), /isn't a single key in canonical notation/);
});
