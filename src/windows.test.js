const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');
const Handler = require('./handler');

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** @type {string[]} */
let calls = [];

class Pane extends Handler {
  static kind = 'pane';
  static contributes = {
    commands: [{ method: 'down', title: 'Down' }],
    keybindings: [{ key: 'j', command: 'pane.down' }],
  };

  down() {
    calls.push(`${this.path} down`);
  }
}

class Confirm extends Handler {
  static kind = 'confirm';
  static contributes = {
    commands: [{ method: 'yes', title: 'Yes' }, { method: 'no', title: 'No' }],
    keybindings: [{ key: 'y', command: 'confirm.yes' }, { key: 'n', command: 'confirm.no' }],
  };

  /** @param {{ failInit?: boolean }} [options] */
  constructor(options = {}) {
    super('confirm');
    this.options = options;
  }

  onInit() {
    if (this.options.failInit) {
      throw new Error('confirm failed');
    }
  }

  yes() {
    return this.close(true);
  }

  no() {
    return this.close(false);
  }
}

class Main extends Handler {
  constructor() {
    super('main');
    this.add(new Pane('left'));
    this.add(new Pane('right'));
  }
}

async function setup() {
  calls = [];
  const vin = new Vin();
  vin.register(new Main());
  await vin.init();
  await vin.openWindow('main');
  const left = vin.resolve('main.left');
  left.focus();
  /** @param {string} chord */
  const press = async (chord) => {
    const used = await vin.call('core.press', chord);
    await tick();
    return used;
  };
  const windows = () => vin.windows.windows.map((w) => `${w.path}:${w.focus}`);
  return { vin, left, press, windows };
}

test('a window opens over the others with the focus, and resolves with what it closes with', async () => {
  const { vin, left, press, windows } = await setup();
  const answer = left.openWindow(new Confirm());
  await tick();
  assert.deepEqual(windows(), ['main:main.left', 'main.left.confirm:main.left.confirm']);
  assert.equal(await press('j'), false, 'the covered window gets no keys');
  assert.equal(await press('y'), true);
  assert.equal(await answer, true);
  assert.deepEqual(windows(), ['main:main.left'], 'the focus is back where it was');
  assert.equal(left.children.has('confirm'), false, 'removed and disposed');
  await press('j');
  assert.deepEqual(calls, ['main.left down']);
  const core = /** @type {InstanceType<typeof import('./handlers/core/core')>} */ (vin.resolve('core'));
  assert.equal(core.state.windows.length, 1, 'core mirrors the stack');
});

test('Escape dismisses the window on top with null, but never the main window', async () => {
  const { left, press, windows } = await setup();
  const answer = left.openWindow(new Confirm());
  await tick();
  assert.equal(await press('escape'), true);
  assert.equal(await answer, null);
  assert.deepEqual(windows(), ['main:main.left']);
  await press('escape');
  assert.deepEqual(windows(), ['main:main.left']);
});

test('closing a window closes the ones it opened, and a second close is ignored', async () => {
  const { vin, left, windows } = await setup();
  const outer = left.openWindow(new Confirm());
  await tick();
  const confirm = vin.resolve('main.left.confirm');
  const inner = confirm.openWindow(new Confirm());
  await tick();
  assert.deepEqual(windows(), ['main:main.left', 'main.left.confirm:main.left.confirm', 'main.left.confirm.confirm:main.left.confirm.confirm']);
  await Promise.all([confirm.close('first'), confirm.close('second')]);
  assert.equal(await outer, 'first');
  assert.equal(await inner, null);
  assert.deepEqual(windows(), ['main:main.left']);
});

test('the focus moves within a window, and climbs out of a disposed handler', async () => {
  const { vin, left, windows } = await setup();
  const right = vin.resolve('main.right');
  right.focus();
  assert.deepEqual(windows(), ['main:main.right']);
  await vin.resolve('main').remove('right');
  assert.deepEqual(windows(), ['main:main']);
  assert.throws(() => right.focus(), /"right" can't take the focus/);
  left.openWindow(new Confirm());
  await tick();
  left.focus();
  assert.deepEqual(windows(), ['main:main.left', 'main.left.confirm:main.left.confirm'], 'a covered window keeps it for later');
});

test('mistakes are reported and leave nothing behind', async () => {
  const { vin, left, windows } = await setup();
  await assert.rejects(left.openWindow(new Confirm({ failInit: true })), /confirm failed/);
  assert.equal(left.children.has('confirm'), false);
  assert.deepEqual(windows(), ['main:main.left']);
  await assert.rejects(left.close(), /"main" wasn't opened with openWindow\(\), so it can't be closed/);
  await assert.rejects(vin.openWindow('main'), /"main" is already open/);

  left.openWindow(new Confirm());
  await tick();
  const confirm = vin.resolve('main.left.confirm');
  await assert.rejects(confirm.close(/** @type {any} */ (new Date())), /Result of window "main.left.confirm"/);
  await assert.rejects(left.openWindow(new Confirm()), /already has a sub-handler named "confirm"/);
  assert.equal(windows().length, 2);

  const orphan = new Handler('orphan');
  await assert.rejects(orphan.openWindow(new Confirm()), /"orphan" can't open windows/);
});

test('disposing vin settles every open window with null', async () => {
  const { vin, left } = await setup();
  const answer = left.openWindow(new Confirm());
  await tick();
  await vin.dispose();
  assert.equal(await answer, null);
  assert.deepEqual(vin.windows.windows, []);
});
