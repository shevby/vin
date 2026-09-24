// Loaded before every test file (npm test).

// Tests make things fail on purpose; without this, their errors would go to the project's vin.log.
process.env.VIN_LOG ??= '';

require('./jsx-hooks');
