const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Trash } = require('./trash');
const { paths } = require('./paths');
const { ROOT, volatile } = require('./volatile');

/**
 * A trash with these options, its records in a temp `.vin`.
 * @param {import('node:test').TestContext} t
 * @param {{ [id: string]: unknown }} options
 */
function trashWith(t, options) {
  const saved = volatile.directory;
  volatile.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-trash-'));
  t.after(() => {
    fs.rmSync(volatile.directory, { recursive: true, force: true });
    volatile.directory = saved;
  });
  return new Trash({ config: { get: (id) => options[id] } });
}

test('the trash is in .vin unless pane.trashDirectory says, relative to vin\'s folder; off, it says so', (t) => {
  const trash = trashWith(t, { 'pane.trash': true, 'pane.trashDirectory': '' });
  assert.equal(trash.directory(), path.join(volatile.directory, 'trash'));
  assert.equal(trash.real('trash:///a%20b/c'), paths.toUri(path.join(volatile.directory, 'trash', 'a b', 'c')));
  assert.equal(trash.contains('trash:///x'), true);
  assert.equal(trash.contains(paths.toUri(path.join(volatile.directory, 'trash', 'x'))), true);
  assert.equal(trash.contains(paths.toUri(volatile.directory)), false);
  assert.equal(trashWith(t, { 'pane.trash': true, 'pane.trashDirectory': 'bin' }).directory(), path.join(ROOT, 'bin'));
  const off = trashWith(t, { 'pane.trash': false, 'pane.trashDirectory': '' });
  assert.throws(() => off.directory(), /The trash is off: turn on pane\.trash in the config/);
  assert.equal(off.contains(paths.toUri(ROOT)), false);
});

test('records say where entries came from until forgotten, in .vin/trash.json', (t) => {
  const trash = trashWith(t, { 'pane.trash': true, 'pane.trashDirectory': '' });
  const origin = paths.toUri(path.join(os.homedir(), 'notes.txt'));
  assert.equal(trash.origin('trash:///notes.txt'), null);
  trash.record('trash:///notes.txt', origin);
  assert.equal(trash.origin('trash:///notes.txt'), origin);
  assert.equal(trash.origin(trash.real('trash:///notes.txt')), origin, 'by its file: URI too');
  trash.forget(['trash:///notes.txt']);
  assert.equal(trash.origin('trash:///notes.txt'), null);
  fs.writeFileSync(path.join(volatile.directory, 'trash.json'), '{ broken');
  assert.throws(() => trash.origin('trash:///x'), /aren't JSON; fix or delete the file/);
});
