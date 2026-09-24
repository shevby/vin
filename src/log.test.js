const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('./log');

test('writes timestamped, leveled lines with error stacks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'vin.log');

  const log = createLogger(file);
  log.info('opened %s', 'C:\\folder');
  log.error(new Error('boom'));

  const lines = fs.readFileSync(file, 'utf8');
  assert.match(lines, /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO opened C:\\folder$/m);
  assert.match(lines, /ERROR Error: boom\n\s+at /);
});

test('is a no-op when no file is given', () => {
  const log = createLogger(undefined);
  assert.doesNotThrow(() => log.error('ignored'));
});

test('fails at creation for a path that cannot be opened', () => {
  assert.throws(() => createLogger(path.join(os.tmpdir(), 'vin-missing-dir', 'nested', 'vin.log')), { code: 'ENOENT' });
});
