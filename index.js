#!/usr/bin/env node
const Vin = require('./src/vin');
const { log } = require('./src/log');

log.info('vin starting', { node: process.version, platform: process.platform, argv: process.argv.slice(2) });

new Vin().start().catch((error) => {
  log.error(error);
  console.error(error);
  process.exitCode = 1;
});
