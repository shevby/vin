const test = require('node:test');
const assert = require('node:assert/strict');
const { formatSize, formatTime } = require('./format');

test('formatSize shows bytes 1024-based in at most 6 cells', () => {
  /** @type {[number, string][]} */
  const cases = [
    [0, '0 B'],
    [312, '312 B'],
    [1023, '1023 B'],
    [1024, '1.0 K'],
    [4300, '4.2 K'],
    [10_188, '9.9 K'],
    [10_200, '10 K'],
    [1023 * 1024, '1023 K'],
    [1024 * 1024 - 1, '1.0 M'],
    [18 * 1024 ** 2, '18 M'],
    [3.5 * 1024 ** 3, '3.5 G'],
    [2 * 1024 ** 4, '2.0 T'],
  ];
  for (const [bytes, text] of cases) {
    assert.equal(formatSize(bytes), text, String(bytes));
    assert.ok(text.length <= 6);
  }
});

test('formatTime shows the time within this year, the year otherwise', () => {
  assert.equal(formatTime(new Date(2026, 8, 24, 14, 3).getTime(), 2026), 'Sep 24 14:03');
  assert.equal(formatTime(new Date(2026, 0, 5, 9, 7).getTime(), 2026), 'Jan  5 09:07');
  assert.equal(formatTime(new Date(2024, 2, 2, 11, 15).getTime(), 2026), 'Mar  2  2024');
  assert.equal(formatTime(new Date(2027, 10, 30).getTime(), 2026), 'Nov 30  2027');
});
