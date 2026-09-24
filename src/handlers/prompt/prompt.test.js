const test = require('node:test');
const assert = require('node:assert/strict');
const Prompt = require('./prompt');
const { openOverMain } = require('../../../test/dialogs');

test('the text field has the focus; Enter closes with the text, Escape with null', async () => {
  const rename = await openOverMain(new Prompt({ message: 'New name', value: 'notes.txt', cursor: 5 }));
  assert.equal(rename.focus(), 'main.prompt.input');
  assert.deepEqual(rename.window.state, { title: null, message: 'New name', error: null });
  await rename.press('shift+x ctrl+e');
  await rename.paste('.bak\n');
  await rename.press('enter');
  assert.equal(await rename.result, 'notesX.txt.bak');

  const dismissed = await openOverMain(new Prompt());
  await dismissed.press('a escape');
  assert.equal(await dismissed.result, null);
});

test('a failed validation shows its message and keeps the prompt open until the text changes', async () => {
  /** @type {string[]} */
  const checked = [];
  const prompt = await openOverMain(
    new Prompt({
      message: 'Name',
      value: 'taken',
      validate: async (value) => {
        checked.push(value);
        return value === 'taken' ? `"${value}" already exists` : null;
      },
    }),
  );
  await prompt.press('enter');
  assert.equal(prompt.closed(), false);
  assert.equal(prompt.window.state.error, '"taken" already exists');
  await prompt.press('backspace');
  assert.equal(prompt.window.state.error, null, 'editing clears it');
  await prompt.press('2 enter');
  assert.equal(await prompt.result, 'take2');
  assert.deepEqual(checked, ['taken', 'take2']);
});

test('a secret prompt says so to the UI; bad options fail at construction', async () => {
  const secret = await openOverMain(new Prompt({ message: 'Passphrase', secret: true }));
  assert.equal(secret.window.input.state.secret, true);
  assert.throws(() => new Prompt({ message: /** @type {any} */ (5) }), /message must be a string/);
  assert.throws(() => new Prompt({ validate: /** @type {any} */ ('x') }), /validate must be a function/);
});
