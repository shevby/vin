// Loaded before every test file (npm test).

// Tests make things fail on purpose; without this, their errors would go to the project's .vin/vin.log.
process.env.VIN_LOG ??= '';

// Tests copy files; the user's clipboard stays theirs.
require('../src/clipboard').system.writeText = async () => {};

require('./jsx-hooks');
