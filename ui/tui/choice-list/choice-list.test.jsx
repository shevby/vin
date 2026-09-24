import test from 'node:test';
import assert from 'node:assert/strict';
import ChoiceList from '../../../src/handlers/choice-list/choice-list.js';
import { renderDialog } from '../../../test/ui.jsx';

test('a choice list shows each option after its key, and picks by key', async (t) => {
  const { frame, type, result } = await renderDialog(
    t,
    new ChoiceList({
      message: '~/a.txt already exists',
      choices: [
        { label: 'Overwrite', key: 'o', value: 'overwrite' },
        { label: 'Rename', key: 'r', description: 'as a (1).txt', value: 'rename' },
        { label: 'Cancel' },
      ],
    }),
  );
  assert.match(await frame(), /~\/a\.txt already exists[\s\S]*o Overwrite[\s\S]*r Rename as a \(1\)\.txt[\s\S]*  Cancel/);
  await type('r');
  assert.equal(await result, 'rename');
});
