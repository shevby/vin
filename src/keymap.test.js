const test = require('node:test');
const assert = require('node:assert/strict');
const { KeySequencer } = require('./keymap');

/**
 * A sequencer over fixed bindings (`[keys, depth, name]`), recording what fires and what's pending.
 * @param {[string, number, string][]} bindings
 */
function setup(bindings) {
  /** @type {string[]} */
  const fired = [];
  /** @type {string[]} */
  const pending = [];
  const sequencer = new KeySequencer({
    timeout: 1000,
    candidates: () =>
      bindings.map(([keys, depth, name]) => ({ keys: keys.split(' '), depth, run: () => fired.push(name) })),
    onPending: (keys) => pending.push(keys.join(' ')),
  });
  /** @param {string} keys */
  const press = (keys) => keys.split(' ').map((chord) => sequencer.press(chord, 'main'));
  return { sequencer, fired, pending, press };
}

test('single keys fire at once; unbound keys are reported unused', () => {
  const { fired, press, pending } = setup([['j', 1, 'down']]);
  assert.deepEqual(press('j'), [true]);
  assert.deepEqual(press('x'), [false]);
  assert.deepEqual(fired, ['down']);
  assert.deepEqual(pending, [], 'nothing was ever pending');
});

test('a sequence waits for its next key, and a stray key starts over', () => {
  const { fired, press, pending, sequencer } = setup([['g g', 1, 'top'], ['j', 1, 'down']]);
  press('g');
  assert.deepEqual(sequencer.pending, ['g']);
  press('g');
  assert.deepEqual(fired, ['top']);

  assert.deepEqual(press('g j'), [true, true], 'g waits; j breaks the sequence and fires on its own');
  assert.deepEqual(fired, ['top', 'down']);
  assert.deepEqual(pending, ['g', '', 'g', '']);
});

test('a binding that prefixes a longer one fires after the timeout', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { fired, press } = setup([['g', 1, 'goto'], ['g g', 1, 'top']]);
  press('g');
  assert.deepEqual(fired, []);
  t.mock.timers.tick(999);
  assert.deepEqual(fired, []);
  t.mock.timers.tick(1);
  assert.deepEqual(fired, ['goto']);

  press('g g');
  t.mock.timers.tick(5000);
  assert.deepEqual(fired, ['goto', 'top'], 'the completed sequence cancelled the timeout');
});

test('only the deepest matches count, and the last of equals wins', () => {
  const { fired, press } = setup([
    ['j', 1, 'outer j'],
    ['j', 2, 'inner j'],
    ['j', 2, 'user j'],
    ['k', 1, 'outer k'],
    ['g', 1, 'outer g'],
    ['g g', 2, 'inner gg'],
  ]);
  press('j');
  press('k');
  press('g g');
  assert.deepEqual(fired, ['user j', 'outer k', 'inner gg']);
});

test('changing focus mid-sequence drops the pending keys', () => {
  const { fired, sequencer } = setup([['g g', 1, 'top']]);
  sequencer.press('g', 'main.left');
  sequencer.press('g', 'main.right');
  assert.deepEqual(fired, []);
  assert.deepEqual(sequencer.pending, ['g']);
  sequencer.reset();
  assert.deepEqual(sequencer.pending, []);
});
