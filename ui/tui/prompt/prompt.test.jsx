import test from 'node:test';
import assert from 'node:assert/strict';
import Prompt from '../../../src/handlers/prompt/prompt.js';
import { renderDialog } from '../../../test/ui.jsx';

test('a prompt shows its question and the text as it is typed; Enter answers', async (t) => {
  const { frame, type, result } = await renderDialog(
    t,
    new Prompt({ title: 'Rename', message: 'New name', value: 'a.txt', cursor: 1, validate: (value) => (value === 'a.txt' ? 'Unchanged' : null) }),
  );
  assert.match(await frame(), /Rename[\s\S]*New name[\s\S]*│ a\.txt/);
  await type('enter');
  assert.match(await frame(), /Unchanged/);
  // `j` is typed, not a key for anything; "bc" arrives at once, as a quick paste does.
  await type('j', 'bc', 'left', 'backspace');
  assert.match(await frame(), /│ ajc\.txt/);
  assert.doesNotMatch(await frame(), /Unchanged/);
  await type('enter');
  assert.equal(await result, 'ajc.txt');
});

test('a secret prompt shows dots; Escape dismisses it', async (t) => {
  const { frame, type, result } = await renderDialog(t, new Prompt({ message: 'Passphrase', secret: true }));
  await type('p', 'w');
  assert.match(await frame(), /│ ••/);
  assert.doesNotMatch(await frame(), /pw/);
  await type('escape');
  assert.equal(await result, null);
});
