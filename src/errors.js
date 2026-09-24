const { paths: defaultPaths } = require('./paths');

/**
 * Telling expected failures from bugs, and putting them in words for the user.
 *
 * A failure is expected — part of working with files, not a mistake in vin — when its `code` says so:
 * the file system's (`ENOENT`, `EACCES`, `EBUSY`, …, which every provider uses; `src/fs/file-system.js`),
 * the network's, and vin's own (`EPATH`, `ECONFIG`, `EFAIL`). It's shown as a message and nothing more.
 * Anything else is a bug: shown too, and logged with its stack (`src/messages.js`). The code is what
 * decides, since it's what survives JSON-RPC — a foreign plugin's errors are judged the same way.
 */

/**
 * The expected codes that have a generic reason, shown when the error has no `reason` of its own.
 * @type {Readonly<{ [code: string]: string }>}
 */
const REASONS = Object.freeze({
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EPERM: 'Operation not permitted',
  EBUSY: 'Busy or locked by another program',
  EEXIST: 'Already exists',
  ENOTEMPTY: 'Directory not empty',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EXDEV: "Can't move between file systems",
  ENOSPC: 'No space left on the device',
  EDQUOT: 'Disk quota exceeded',
  EROFS: 'Read-only file system',
  EFBIG: 'File too large',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'Name too long',
  EMFILE: 'Too many open files',
  ENFILE: 'Too many open files',
  EIO: 'Input/output error',
  EINVAL: 'Invalid argument',
  ENOSYS: 'Not supported',
  ENOTSUP: 'Not supported',
  ECANCELED: 'Cancelled',
  ENOPROVIDER: 'No file system for this location',
  ETIMEDOUT: 'Timed out',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection lost',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ENOTFOUND: 'Host not found',
});

/** The `code` of `failure()` errors. */
const FAILURE = 'EFAIL';

/** Every expected code: those in `REASONS`, and ones whose message is already written for the user. */
const EXPECTED = new Set([...Object.keys(REASONS), 'EPATH', 'ECONFIG', FAILURE]);

/**
 * An expected failure, with a message written for the user — for a command to give up with, e.g.
 * `throw failure('Nothing to paste')`.
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function failure(message) {
  return Object.assign(new Error(message), { code: FAILURE });
}

/**
 * @param {unknown} error
 * @returns {boolean} Whether `error` is an expected failure rather than a bug.
 */
function isExpected(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  return typeof code === 'string' && EXPECTED.has(code);
}

/**
 * What went wrong, in one line for the user. For a file system error: its reason and the paths it
 * concerns, shown as vin shows paths (`Permission denied: ~/notes.txt`, `Already exists: ~/a → ~/b`).
 * For anything else, its message without a leading `CODE: `.
 * @param {unknown} error Anything thrown.
 * @param {InstanceType<typeof import('./paths').Paths>} [paths] Whose rules show the paths.
 * @returns {string}
 */
function describeError(error, paths = defaultPaths) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { code, reason, path, dest } = /** @type {Error & { code?: unknown, reason?: unknown, path?: unknown, dest?: unknown }} */ (error);
  const where = [path, dest].filter((item) => typeof item === 'string').map((item) => showLocation(item, paths));
  const known = typeof code === 'string' && Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
  if (where.length && (typeof reason === 'string' || known)) {
    return `${typeof reason === 'string' ? reason : known}: ${where.join(' → ')}`;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  if (typeof code === 'string' && error.message.startsWith(`${code}: `)) {
    // Node's own lowercase `ENOENT: no such file or directory`.
    return capitalize(error.message.slice(code.length + 2));
  }
  return error.message || (known ?? error.name);
}

/**
 * @param {string} location A native path, or a URI: a `file:` URI is shown as its path, and any other as it
 *   is (`sftp://host/x`).
 * @param {InstanceType<typeof import('./paths').Paths>} paths
 * @returns {string}
 */
function showLocation(location, paths) {
  try {
    if (/^file:/i.test(location)) {
      return paths.display(paths.fromUri(location));
    }
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(location)) {
      return location;
    }
    return paths.display(paths.resolve(location));
  } catch {
    // Not a path these rules read — shown as the error gave it.
    return location;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

module.exports = { describeError, isExpected, failure, FAILURE, REASONS };
