const fs = require('node:fs');
const util = require('node:util');

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} debug
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 */

/**
 * Creates a logger that appends to `file`, or a no-op logger when `file` is empty.
 * Arguments are formatted like `console.log`, so an `Error` is written with its stack.
 * @param {string | undefined} file
 * @returns {Logger}
 * @throws {Error} If `file` can't be opened for appending.
 */
function createLogger(file) {
  if (!file) {
    const noop = () => {};
    return { debug: noop, info: noop, warn: noop, error: noop };
  }
  // Touch the file now so a bad path fails at startup, not at the first log call.
  fs.appendFileSync(file, '');

  /** @param {string} level */
  const writer = (level) => (/** @type {unknown[]} */ ...args) => {
    fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${util.format(...args)}\n`);
  };
  return { debug: writer('DEBUG'), info: writer('INFO'), warn: writer('WARN'), error: writer('ERROR') };
}

/** Process-wide logger, enabled by setting `VIN_LOG` to a file path. */
const log = createLogger(process.env.VIN_LOG);

module.exports = { log, createLogger };
