const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

/**
 * `.vin/vin.log` in the project root (git-ignored, like everything vin writes as it runs), where errors go
 * when `VIN_LOG` isn't set. It's found through `package.json` rather than `__dirname`, which the TUI bundle
 * (ESM) doesn't have; this file and the bundle both sit one level below the root.
 */
const DEFAULT_LOG_FILE = path.join(path.dirname(require.resolve('../package.json')), '.vin', 'vin.log');

/** @typedef {'debug' | 'info' | 'warn' | 'error'} Level */

/** @type {Level[]} */
const LEVELS = ['debug', 'info', 'warn', 'error'];

/**
 * @typedef {object} Logger
 * @property {(...args: unknown[]) => void} debug
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 * @property {string | null} file The log file's absolute path, or `null` when logging is off.
 */

/**
 * Creates a logger that appends to `file`, or a no-op logger when `file` is empty.
 * Arguments are formatted like `console.log`, so an `Error` is written with its stack.
 * @param {string | undefined} file
 * @param {object} [options]
 * @param {Level} [options.level] The lowest level written; lower ones are dropped. Default: `debug`.
 * @param {boolean} [options.optional] The file, and its directory, are created by the first line written,
 *   and failing to write is ignored — for the default log, which must never stop vin. Otherwise it's opened
 *   now, so a bad path fails at startup, not at the first log call.
 * @returns {Logger}
 * @throws {Error} If `file` isn't optional and can't be opened for appending.
 */
function createLogger(file, { level = 'debug', optional = false } = {}) {
  const noop = () => {};
  if (!file) {
    return { debug: noop, info: noop, warn: noop, error: noop, file: null };
  }
  const target = path.resolve(file);
  if (!optional) {
    fs.appendFileSync(target, '');
  }
  const lowest = LEVELS.indexOf(level);
  /** @param {Level} name */
  const writer = (name) => {
    if (LEVELS.indexOf(name) < lowest) {
      return noop;
    }
    return (/** @type {unknown[]} */ ...args) => {
      const line = `${new Date().toISOString()} ${name.toUpperCase()} ${util.format(...args)}\n`;
      try {
        fs.appendFileSync(target, line);
      } catch (error) {
        if (!optional) {
          throw error;
        }
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.appendFileSync(target, line);
        } catch {
          // Lost: the optional log must never stop vin.
        }
      }
    };
  };
  return { debug: writer('debug'), info: writer('info'), warn: writer('warn'), error: writer('error'), file: target };
}

/**
 * The logger a `VIN_LOG` setting asks for: every level to that file when it's a path, nothing when it's
 * empty, and when it's unset, errors only to `.vin/vin.log` in the project root — so an unexpected error is
 * never lost.
 * @param {string | undefined} setting
 * @param {string} [fallback] The file for errors when `setting` is unset.
 * @returns {Logger}
 */
function loggerFor(setting, fallback = DEFAULT_LOG_FILE) {
  return setting === undefined ? createLogger(fallback, { level: 'error', optional: true }) : createLogger(setting);
}

/** Process-wide logger, from `VIN_LOG`. */
const log = loggerFor(process.env.VIN_LOG);

module.exports = { log, createLogger, loggerFor, DEFAULT_LOG_FILE };
