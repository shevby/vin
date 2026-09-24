#!/usr/bin/env node
const Vin = require('./src/vin');
const Main = require('./src/handlers/main/main');
const { log } = require('./src/log');

log.info('vin starting', { node: process.version, platform: process.platform, argv: process.argv.slice(2) });

const vin = new Vin();
vin.register(new Main());
vin.start({ window: 'main' }).catch((error) => {
  log.error(error);
  // A config mistake is the user's to fix, so it gets its list of problems, not a stack trace.
  console.error(error?.code === 'ECONFIG' ? error.message : error);
  process.exitCode = 1;
});
