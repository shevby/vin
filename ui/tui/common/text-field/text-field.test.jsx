import test from 'node:test';
import assert from 'node:assert/strict';
import { visible } from './index.js';

test('visible keeps the cursor in view, scrolling long text', () => {
  const chars = [...'abcdefgh'];
  assert.deepEqual(visible(chars, 8, 20), { before: 'abcdefgh', at: ' ', after: ' '.repeat(11) });
  assert.deepEqual(visible(chars, 2, 20), { before: 'ab', at: 'c', after: `defgh${' '.repeat(12)}` });
  assert.deepEqual(visible(chars, 8, 4), { before: 'fgh', at: ' ', after: '' });
  assert.deepEqual(visible(chars, 5, 4), { before: 'cde', at: 'f', after: '' });
  assert.deepEqual(visible(chars, 0, 4), { before: '', at: 'a', after: 'bcd' });
  assert.deepEqual(visible([], 0, 0), { before: '', at: ' ', after: '' });
});
