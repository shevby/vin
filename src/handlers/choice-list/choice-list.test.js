const test = require('node:test');
const assert = require('node:assert/strict');
const ChoiceList = require('./choice-list');
const { openOverMain } = require('../../../test/dialogs');

const conflict = () =>
  new ChoiceList({
    title: 'Conflict',
    message: '~/a.txt already exists',
    choices: [
      { label: 'Overwrite', key: 'o', value: 'overwrite' },
      { label: 'Skip', key: 's', value: 'skip' },
      { label: 'Rename', key: 'r', description: 'as a.txt (1)', value: { rename: 'a (1).txt' } },
      { label: 'Cancel' },
    ],
  });

test('keys move the highlight, Enter picks it; the result is the value, else the index', async () => {
  const list = await openOverMain(conflict());
  assert.deepEqual(list.window.state.choices[2], { label: 'Rename', key: 'r', description: 'as a.txt (1)' });
  await list.press('j j down k');
  assert.equal(list.window.state.selected, 2);
  await list.press('shift+g');
  assert.equal(list.window.state.selected, 3);
  await list.press('ctrl+n j');
  assert.equal(list.window.state.selected, 3, 'stops at the last');
  await list.press('g g up');
  assert.equal(list.window.state.selected, 0, 'stops at the first');
  await list.press('end enter');
  assert.equal(await list.result, 3, 'no value: the index');

  const renamed = await openOverMain(conflict());
  await renamed.press('down down enter');
  assert.deepEqual(await renamed.result, { rename: 'a (1).txt' });
});

test("an option's key picks it at once, even over a keybinding; other characters don't", async () => {
  const list = await openOverMain(
    new ChoiceList({ choices: [{ label: 'Keep' }, { label: 'Junk', key: 'j', value: 'junk' }] }),
  );
  await list.press('x');
  assert.equal(list.closed(), false);
  await list.press('j');
  assert.equal(await list.result, 'junk');

  const dismissed = await openOverMain(conflict());
  await dismissed.press('escape');
  assert.equal(await dismissed.result, null);
});

test('bad options fail at construction', () => {
  assert.throws(() => new ChoiceList({ choices: [] }), /needs at least one choice/);
  assert.throws(() => new ChoiceList({ choices: [/** @type {any} */ ({})] }), /choice 0 needs a non-empty string label/);
  assert.throws(() => new ChoiceList({ choices: [{ label: 'a', key: 'ab' }] }), /key must be one character/);
  assert.throws(() => new ChoiceList({ choices: [{ label: 'a', key: 'x' }, { label: 'b', key: 'x' }] }), /choice 1: key "x" is already/);
  assert.throws(() => new ChoiceList({ choices: [{ label: 'a' }], selected: 1 }), /selected must be an index/);
  assert.throws(() => new ChoiceList({ choices: [{ label: 'a', value: /** @type {any} */ (new Map()) }] }), /choice 0/);
});
