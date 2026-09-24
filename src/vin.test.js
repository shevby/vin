const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('./vin');

test('registers a handler and looks it up by name', () => {
  const vin = new Vin();
  const handler = { name: 'zip' };
  vin.register(handler);
  assert.equal(vin.getHandler('zip'), handler);
});

test('rejects a second handler with the same name', () => {
  const vin = new Vin();
  vin.register({ name: 'zip' });
  assert.throws(() => vin.register({ name: 'zip' }), /already registered/);
});
