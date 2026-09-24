const test = require('node:test');
const assert = require('node:assert/strict');
const Confirm = require('./confirm');
const { openOverMain } = require('../../../test/dialogs');

test('y and n answer at once; Escape dismisses with null', async () => {
  const yes = await openOverMain(new Confirm({ message: 'Delete 3 files?' }));
  await yes.press('y');
  assert.equal(await yes.result, true);

  const no = await openOverMain(new Confirm({ message: 'Delete 3 files?' }));
  await no.press('n');
  assert.equal(await no.result, false);

  const dismissed = await openOverMain(new Confirm({ message: 'Delete 3 files?' }));
  await dismissed.press('escape');
  assert.equal(await dismissed.result, null);
});

test('Enter presses the highlighted button, which starts where the caller says', async () => {
  const careful = await openOverMain(new Confirm({ message: 'Delete permanently?', title: 'Delete', yes: 'Delete', no: 'Keep', initial: 'no' }));
  assert.deepEqual(careful.window.state, { title: 'Delete', message: 'Delete permanently?', yes: 'Delete', no: 'Keep', selected: 'no' });
  await careful.press('j x');
  assert.equal(careful.closed(), false, 'other keys do nothing');
  await careful.press('enter');
  assert.equal(await careful.result, false);

  const moved = await openOverMain(new Confirm({ message: 'Overwrite?' }));
  await moved.press('right');
  assert.equal(moved.window.state.selected, 'no');
  await moved.press('h');
  assert.equal(moved.window.state.selected, 'yes');
  await moved.press('tab tab shift+tab');
  assert.equal(moved.window.state.selected, 'no');
  await moved.press('l enter');
  assert.equal(await moved.result, false);
});

test('bad options fail at construction', () => {
  assert.throws(() => new Confirm(/** @type {any} */ ({})), /needs a non-empty string message/);
  assert.throws(() => new Confirm({ message: 'x', yes: '' }), /needs a non-empty string yes/);
  assert.throws(() => new Confirm({ message: 'x', initial: /** @type {any} */ ('maybe') }), /Expected "yes" or "no"/);
  assert.throws(() => new Confirm({ message: 'x', title: /** @type {any} */ (1) }), /title must be a string/);
});
