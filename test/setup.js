// Loaded before every test file (npm test).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests make things fail on purpose; without this, their errors would go to the project's .vin/vin.log.
process.env.VIN_LOG ??= '';

// Tests delete to the trash; the project's .vin stays as it was.
const volatile = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-test-'));
require('../src/volatile').volatile.directory = volatile;
process.on('exit', () => fs.rmSync(volatile, { recursive: true, force: true }));

// Tests copy files; the user's clipboard stays theirs.
require('../src/clipboard').system.writeText = async () => {};

require('./jsx-hooks');
