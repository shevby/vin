const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger, loggerFor, DEFAULT_LOG_FILE } = require('./log');

/**
 * @param {import('node:test').TestContext} t
 * @returns {string} A file in a temporary directory, removed after the test.
 */
function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'vin.log');
}

test('writes timestamped, leveled lines with error stacks', (t) => {
  const file = tempFile(t);
  const log = createLogger(file);
  log.info('opened %s', 'C:\\folder');
  log.error(new Error('boom'));

  const lines = fs.readFileSync(file, 'utf8');
  assert.match(lines, /^\d{4}-\d\d-\d\dT[\d:.]+Z INFO opened C:\\folder$/m);
  assert.match(lines, /ERROR Error: boom\n\s+at /);
  assert.equal(log.file, file);
});

test('is a no-op when no file is given', () => {
  const log = createLogger(undefined);
  assert.doesNotThrow(() => log.error('ignored'));
  assert.equal(log.file, null);
});

test('fails at creation for a path that cannot be opened', () => {
  assert.throws(() => createLogger(path.join(os.tmpdir(), 'vin-missing-dir', 'nested', 'vin.log')), { code: 'ENOENT' });
});

test('drops levels below the lowest; an optional file waits for its first line and never throws', (t) => {
  const file = tempFile(t);
  const log = createLogger(file, { level: 'error', optional: true });
  log.warn('dropped');
  assert.ok(!fs.existsSync(file), 'not created until something is written');
  log.error('kept');
  assert.match(fs.readFileSync(file, 'utf8'), /^\S+ ERROR kept\n$/);

  const unwritable = createLogger(path.join(path.dirname(file), 'missing', 'vin.log'), { optional: true });
  assert.doesNotThrow(() => unwritable.error('lost'));
});

test('VIN_LOG: a path logs everything, empty logs nothing, unset logs errors to vin.log', (t) => {
  const file = tempFile(t);
  const all = loggerFor(file);
  all.debug('debug line');
  assert.match(fs.readFileSync(file, 'utf8'), /DEBUG debug line/);

  assert.equal(loggerFor('').file, null);

  const fallback = path.join(path.dirname(file), 'fallback.log');
  const errors = loggerFor(undefined, fallback);
  errors.info('dropped');
  errors.error('kept');
  assert.equal(errors.file, fallback);
  assert.doesNotMatch(fs.readFileSync(fallback, 'utf8'), /dropped/);

  assert.equal(DEFAULT_LOG_FILE, path.join(__dirname, '..', 'vin.log'));
});
