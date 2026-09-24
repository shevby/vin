const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');
const Handler = require('./handler');
const Main = require('./handlers/main/main');
const { checkStyle, isColor } = require('./colors');

test('colors are 256-color numbers, #hex, names, or default', () => {
  for (const color of [0, 149, 255, '#fff', '#AbCdEf', 'blue', 'redBright', 'gray', 'default']) {
    assert.ok(isColor(color), String(color));
  }
  for (const color of [-1, 256, 1.5, '#ff', '#gggggg', 'Blue', 'purple', '', null, true]) {
    assert.ok(!isColor(color), String(color));
  }
});

test('a style holds colors and on/off attributes, nothing else', () => {
  assert.equal(checkStyle({}), null);
  assert.equal(checkStyle({ fg: 234, bg: '#afd75f', bold: true, italic: false, underline: false, inverse: true }), null);
  assert.match(String(checkStyle({ fg: 300 })), /^"fg" must be a color — 0 to 255, "#rrggbb", a name like "blue", or "default"; got 300$/);
  assert.match(String(checkStyle({ bold: 'yes' })), /^"bold" must be true or false; got "yes"$/);
  assert.match(String(checkStyle({ color: 1 })), /^has an unknown field "color"; expected "fg", "bg", "bold"/);
  assert.match(String(checkStyle([])), /^must be an object like \{ fg: 74, bold: true \}; got \[\]$/);
});

test('a group is declared with a valid default, by kind', async () => {
  class Bad extends Handler {
    static contributes = { colors: [{ key: 'x', default: { fg: 'purple' } }] };
  }
  const vin = new Vin();
  vin.register(new Bad('bad'));
  await assert.rejects(vin.init(), /colors\[0\] from "bad": the default "fg" must be a color/);
  assert.throws(
    () => vin.registry.contribute('colors', [{ key: 'x', default: {} }], { source: 'config', user: true }),
    /user config sets them under "colors"/,
  );
});

test('core mirrors the scheme — every group, with the user\'s changes — for the UI', async () => {
  const vin = new Vin();
  vin.register(new Main());
  vin.config.parse('{ colors: { pane: { titleActive: { bg: 33 } }, core: { error: { bold: false } } } }', 'config.json5');
  await vin.init();
  vin.config.check();
  const core = /** @type {InstanceType<typeof import('./handlers/core/core')>} */ (vin.resolve('core'));
  assert.deepEqual(core.state.colors['pane.titleActive'], { fg: 234, bg: 33, bold: true }, 'only what it names');
  assert.deepEqual(core.state.colors['core.error'], { fg: 160, bold: false });
  assert.deepEqual(core.state.colors['core.window'], { fg: 252, bg: 234 }, "papercolor-dark's Win");
  assert.equal(vin.config.reader.style('pane.title').fg, 71);
});
