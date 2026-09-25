const path = require('node:path');

/** vin's folder — the project root, where `config.json5` and `plugins/` are. */
const ROOT = path.dirname(require.resolve('../package.json'));

/**
 * Where vin keeps what it writes as it runs — the trash (2.9), later sessions (2.17, 2.22): `.vin/` in
 * vin's folder, git-ignored. An object, so tests move it to a temp directory (`test/setup.js`). The log
 * (`src/log.js`) is there too, decided on its own.
 */
const volatile = { directory: path.join(ROOT, '.vin') };

module.exports = { ROOT, volatile };
