#!/usr/bin/env node
const Vin = require('./src/vin');

new Vin().start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
