const test = require('node:test');
const assert = require('node:assert/strict');
const Handler = require('./handler');

/** Records lifecycle hooks into a shared log, optionally failing in one of them. */
class Recorder extends Handler {
  /**
   * @param {string} name
   * @param {string[]} events
   * @param {{ failInit?: boolean, failDispose?: boolean }} [options]
   */
  constructor(name, events, options = {}) {
    super(name);
    this.events = events;
    this.options = options;
  }

  async onInit() {
    this.events.push(`init ${this.path}`);
    if (this.options.failInit) {
      throw new Error(`init ${this.path} failed`);
    }
  }

  async onDispose() {
    this.events.push(`dispose ${this.path}`);
    if (this.options.failDispose) {
      throw new Error(`dispose ${this.path} failed`);
    }
  }
}

class Pane extends Handler {
  /** @param {string} dir */
  navigate(dir) {
    return `${this.path} at ${dir}`;
  }

  async count() {
    return 42;
  }

  _helper() {}

  get cwd() {
    return '/';
  }
}

class PreviewPane extends Pane {
  preview() {
    return 'preview';
  }
}

/** Builds `main` with `left` and `right` panes, `left` holding a `preview` sub-handler. */
function tree() {
  const main = new Handler('main');
  const left = main.add(new Pane('left'));
  const right = main.add(new Pane('right'));
  const preview = left.add(new PreviewPane('preview'));
  return { main, left, right, preview };
}

test('rejects names that are empty, contain dots, or start with a non-letter', () => {
  for (const name of ['', 'a.b', '1pane', '-x', 'a b']) {
    assert.throws(() => new Handler(name), TypeError, name);
  }
  assert.equal(new Handler('left-pane_2').name, 'left-pane_2');
});

test('sub-handlers get a parent and a dotted path', () => {
  const { main, left, preview } = tree();
  assert.equal(main.parent, null);
  assert.equal(preview.parent, left);
  assert.equal(main.path, 'main');
  assert.equal(preview.path, 'main.left.preview');
  assert.deepEqual([...main.children.keys()], ['left', 'right']);
});

test('add rejects duplicate names, second parents, and cycles', () => {
  const { main, left } = tree();
  assert.throws(() => main.add(new Handler('left')), /already has a sub-handler named "left"/);
  assert.throws(() => new Handler('other').add(left), /"main.left" already has a parent/);
  assert.throws(() => left.add(main), /its own sub-handler/);
  assert.throws(() => main.add(main), /its own sub-handler/);
});

test('resolve walks a dotted path and names the missing segment', () => {
  const { main, preview } = tree();
  assert.equal(main.resolve('left.preview'), preview);
  assert.throws(() => main.resolve('left.nope.deeper'), /No handler "main.left.nope"/);
});

test('call invokes a method on this handler or a descendant and awaits it', async () => {
  const { main, left, preview } = tree();
  assert.equal(await left.call('navigate', '/tmp'), 'main.left at /tmp');
  assert.equal(await main.call('left.navigate', '/tmp'), 'main.left at /tmp');
  assert.equal(await main.call('left.count'), 42);
  assert.equal(await main.call('left.preview.preview'), 'preview');
  assert.equal(await preview.call('navigate', '/'), 'main.left.preview at /', 'inherited from Pane');
});

test('call refuses anything but public subclass methods', async () => {
  const { main } = tree();
  const refused = [
    '_helper', 'cwd', 'name', 'events', 'constructor', 'toString', 'hasOwnProperty',
    'init', 'dispose', 'add', 'remove', 'resolve', 'call', 'onInit', 'onDispose', 'missing',
    'state', 'update', 'subscribeState', 'emit', 'on',
  ];
  for (const method of refused) {
    await assert.rejects(main.call(`left.${method}`), /no callable method/, method);
  }
  // A plain Handler defines no callable methods of its own.
  await assert.rejects(main.call('toString'), /no callable method/);
});

test('init runs parents before children; dispose runs in reverse', async () => {
  /** @type {string[]} */
  const events = [];
  const main = new Recorder('main', events);
  const left = main.add(new Recorder('left', events));
  left.add(new Recorder('preview', events));
  main.add(new Recorder('right', events));

  await main.init();
  await main.dispose();
  assert.deepEqual(events, [
    'init main', 'init main.left', 'init main.left.preview', 'init main.right',
    'dispose main.right', 'dispose main.left.preview', 'dispose main.left', 'dispose main',
  ]);
});

test('init and dispose are idempotent', async () => {
  /** @type {string[]} */
  const events = [];
  const handler = new Recorder('main', events);
  await Promise.all([handler.init(), handler.init()]);
  await Promise.all([handler.dispose(), handler.dispose()]);
  assert.deepEqual(events, ['init main', 'dispose main']);
});

test('a sub-handler added during onInit is initialized too', async () => {
  /** @type {string[]} */
  const events = [];
  class Lazy extends Recorder {
    async onInit() {
      await super.onInit();
      this.add(new Recorder('late', this.events));
    }
  }
  await new Lazy('main', events).init();
  assert.deepEqual(events, ['init main', 'init main.late']);
});

test('dispose skips onDispose for handlers that never started', async () => {
  /** @type {string[]} */
  const events = [];
  const main = new Recorder('main', events, { failInit: true });
  main.add(new Recorder('left', events));

  await assert.rejects(main.init(), /init main failed/);
  await main.dispose();
  assert.deepEqual(events, ['init main', 'dispose main']);
});

test('dispose runs every step and reports all failures', async () => {
  /** @type {string[]} */
  const events = [];
  const main = new Recorder('main', events, { failDispose: true });
  main.add(new Recorder('left', events, { failDispose: true }));
  main.add(new Recorder('right', events));
  await main.init();

  await assert.rejects(main.dispose(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((e) => e.message), ['dispose main.left failed', 'dispose main failed']);
    return true;
  });
  assert.deepEqual(events.filter((e) => e.startsWith('dispose')), [
    'dispose main.right', 'dispose main.left', 'dispose main',
  ]);
});

test('a disposed handler refuses init, add, and calls', async () => {
  const { main, left } = tree();
  await main.dispose();
  await assert.rejects(main.init(), /Cannot initialize disposed handler "main"/);
  assert.throws(() => main.add(new Handler('x')), /disposed handler "main"/);
  await assert.rejects(left.call('navigate', '/'), /"main.left" is disposed/);
});

test('remove detaches and disposes a sub-handler', async () => {
  /** @type {string[]} */
  const events = [];
  const main = new Recorder('main', events);
  const left = main.add(new Recorder('left', events));
  await main.init();

  await main.remove('left');
  assert.equal(left.parent, null);
  assert.equal(main.children.has('left'), false);
  assert.deepEqual(events, ['init main', 'init main.left', 'dispose main.left']);
  await assert.rejects(main.remove('left'), /no sub-handler named "left"/);
});

test('state: update registers, this.state edits, subscribers follow until dispose', async () => {
  /** @extends {Handler<{ cwd: string }>} */
  class Pane extends Handler {
    /** @param {string} dir */
    navigate(dir) {
      this.state.cwd = dir;
    }
  }
  const pane = new Pane('pane');
  pane.update({ cwd: '/' });
  /** @type {import('./state').StateMessage[]} */
  const messages = [];
  pane.subscribeState((message) => messages.push(message));

  await pane.call('navigate', '/tmp');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [
    { type: 'replace', state: { cwd: '/' } },
    { type: 'patch', patches: [{ op: 'set', path: ['cwd'], value: '/tmp' }] },
  ]);

  pane.state.cwd = '/last';
  await pane.dispose();
  assert.equal(messages.length, 3, 'edits pending at dispose are still delivered');
  pane.state.cwd = '/after';
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 3, 'nothing is sent after dispose');
});
