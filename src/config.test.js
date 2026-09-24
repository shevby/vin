const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Vin = require('./vin');
const Handler = require('./handler');
const { ConfigError } = require('./config');

class Pane extends Handler {
  static kind = 'pane';
  /** @type {import('./contributions').Contributes} */
  static contributes = {
    commands: [{ method: 'down', title: 'Down' }],
    configuration: [
      { key: 'showHidden', type: 'boolean', default: false, description: 'Show dotfiles.' },
      { key: 'sortBy', type: 'string', default: 'name', enum: ['name', 'size', 'modified'] },
      { key: 'columns', type: 'array', default: ['name', 'size'] },
    ],
  };

  down() {}

  onInit() {
    /** @type {unknown} */
    this.seen = this.config.get('pane.showHidden');
  }
}

/**
 * A vin with a pane, the config parsed before init (as `start()` does), and `check()`'s problems.
 * @param {string} text
 */
async function load(text) {
  const vin = new Vin();
  const pane = new Pane('pane');
  vin.register(pane);
  vin.config.parse(text, 'config.json5');
  await vin.init();
  /** @type {string[]} */
  let problems = [];
  try {
    vin.config.check();
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    problems = error.problems;
  }
  return { vin, pane, problems };
}

test("user values override defaults, and any handler reads any option by id", async () => {
  const { vin, pane, problems } = await load(`
    // comments, unquoted keys, single quotes, trailing commas
    {
      pane: { showHidden: true, sortBy: 'size', },
      core: { keyTimeout: 300 },
    }`);
  assert.deepEqual(problems, []);
  assert.equal(pane.seen, true, 'already during onInit()');
  assert.equal(vin.resolve('core').config.get('pane.sortBy'), 'size');
  const columns = /** @type {string[]} */ (pane.config.get('pane.columns'));
  assert.deepEqual(columns, ['name', 'size'], 'the default');
  assert.ok(Object.isFrozen(columns));
  assert.equal(pane.config.get('core.keyTimeout'), 300);
  assert.throws(() => pane.config.get('pane.nope'), /Unknown option "pane.nope"/);
});

test('every mistake is reported with its line and column, and invalid values fall back to defaults', async () => {
  const { vin, problems } = await load(`{
  pane: {
    showHidden: 'yes',
    sortBy: 'date',
    showHiden: true,
    columns: [NaN],
  },
  pnae: {},
  core: 5, // reported as repeated; the last one counts, as in JSON5
  core: { keyTimeout: -1 },
  keybindings: [
    { key: 'J', command: 'pane.dwn' },
    { key: 'ctrl', command: 'pane.down' },
    { key: 'x', command: '-core.nope' },
  ],
}`);
  assert.deepEqual(problems, [
    'config.json5:3:17: "pane.showHidden" must be a boolean; got "yes"',
    'config.json5:4:13: "pane.sortBy" must be one of "name", "size", "modified"; got "date"',
    'config.json5:5:5: unknown option "pane.showHiden"; did you mean "showHidden"?',
    'config.json5:6:14: "pane.columns" can\'t hold NaN or Infinity',
    'config.json5:8:3: unknown section "pnae": nothing declares options under it; did you mean "pane"?',
    'config.json5:10:3: "core" is set again; the first is at line 9',
    'config.json5:10:23: "core.keyTimeout" must be at least 0; got -1',
    'config.json5:12:26: unknown command "pane.dwn"; did you mean "pane.down"?',
    'config.json5:13:5: keybindings[1]: Key "ctrl": "ctrl" needs a key after it, e.g. "ctrl+x"',
    'config.json5:14:26: unknown command "core.nope"',
  ]);
  assert.equal(vin.config.get('pane.sortBy'), 'name');
  assert.equal(vin.config.get('core.keyTimeout'), 1000);
});

test('a syntax error stops at once, and the root must be an object', async () => {
  const vin = new Vin();
  assert.throws(() => vin.config.parse('{ a: 1,, }', 'config.json5'), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.deepEqual(error.problems, ['config.json5:1:8: Unexpected token Comma found.']);
    assert.match(error.message, /^Invalid configuration \(1 problem\):\n {2}config\.json5:1:8/);
    return true;
  });
  const { problems } = await load('[]');
  assert.deepEqual(problems, ['config.json5:1:1: the configuration must be an object: { … }']);
});

test("user keybindings apply after the built-in ones, and replace the last file's", async () => {
  const { vin } = await load(`{ keybindings: [{ key: 'q', command: 'core.closeWindow' }, { key: 'escape', command: '-core.closeWindow' }] }`);
  const bindings = () => vin.registry.get('keybindings').map((b) => `${b.key} ${b.command}`);
  assert.deepEqual(bindings(), ['q core.closeWindow']);
  vin.config.parse('{}');
  assert.deepEqual(bindings(), ['escape core.closeWindow']);
});

test('the key timeout option reaches the key sequencer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  /** @type {string[]} */
  const calls = [];
  class Main extends Handler {
    static contributes = {
      commands: [{ method: 'g', title: 'g' }, { method: 'gg', title: 'g g' }],
      keybindings: [{ key: 'g', command: 'main.g' }, { key: 'g g', command: 'main.gg' }],
    };
    g() {
      calls.push('g');
    }
    gg() {
      calls.push('gg');
    }
  }
  const vin = new Vin();
  vin.register(new Main('main'));
  vin.config.parse('{ core: { keyTimeout: 200 } }');
  await vin.init();
  await vin.openWindow('main');
  await vin.call('core.press', 'g');
  t.mock.timers.tick(199);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ['g']);
});

test('option declarations are checked like other contributions', async () => {
  /**
   * @param {object} option
   * @param {RegExp} message
   */
  const rejects = async (option, message) => {
    class Bad extends Handler {
      static contributes = /** @type {any} */ ({ configuration: [option] });
    }
    const vin = new Vin();
    vin.register(new Bad('bad'));
    await assert.rejects(vin.init(), message);
  };
  await rejects({ key: 'x', type: 'bool', default: true }, /"type" must be one of "boolean", "number", "integer"/);
  await rejects({ key: 'x', type: 'string', default: 1 }, /configuration\[0\] from "bad": the default must be a string; got 1/);
  await rejects({ key: 'x', type: 'integer', default: 1.5 }, /the default must be an integer; got 1.5/);
  await rejects({ key: 'x', type: 'number', default: 5, maximum: 3 }, /the default must be at most 3; got 5/);
  await rejects({ key: 'x.y', type: 'number', default: 5 }, /invalid option key "x.y"/);
  await rejects({ key: 'x', type: 'number' }, /needs "default"/);
  const vin = new Vin();
  assert.throws(
    () => vin.registry.contribute('configuration', [{ key: 'x', type: 'number', default: 1 }], { source: 'config', user: true }),
    /options are declared by handlers and plugins, not by user config/,
  );
});

test('load() reads a file, and create() writes a commented one listing every option, never overwriting', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json5');
  const vin = new Vin({ configFile: file });
  vin.register(new Pane('pane'));
  assert.equal(vin.config.load(file), false, 'missing: all defaults');
  await vin.init();
  assert.equal(vin.config.create(file), true);
  assert.equal(vin.config.create(file), false);

  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\/\/ pane: \{\n\s+\/\/ {3}showHidden: false, \/\/ Show dotfiles\.\n\s+\/\/ {3}sortBy: "name", \/\/ One of: "name", "size", "modified"\./);
  assert.match(text, /\/\/ {3}keyTimeout: 1000, \/\/ How long a key sequence/);
  assert.equal(vin.config.load(file), true);
  vin.config.check();

  const edited = text
    .replace(/\/\/ pane: \{\n\s+\/\/ {3}showHidden: false,/, 'pane: {\n    showHidden: true,')
    .replace(/(pane: \{[\s\S]*?)\/\/ \},/, '$1},');
  fs.writeFileSync(file, edited);
  vin.config.load(file);
  vin.config.check();
  assert.equal(vin.config.get('pane.showHidden'), true, 'uncommenting an option sets it');
});
