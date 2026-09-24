import test from 'node:test';
import assert from 'node:assert/strict';
import Confirm from '../../../src/handlers/confirm/confirm.js';
import { renderDialog } from '../../../test/ui.jsx';

test('a confirm shows its question and buttons, and answers by key', async (t) => {
  const { frame, type, result } = await renderDialog(t, new Confirm({ title: 'Delete', message: 'Delete 3 files permanently?', initial: 'no' }));
  assert.match(await frame(), /Delete[\s\S]*Delete 3 files permanently\?[\s\S]*Yes\s+No/);
  await type('right', 'left', 'enter');
  assert.equal(await result, true);
});
