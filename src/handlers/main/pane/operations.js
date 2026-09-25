const nodePath = require('node:path');
const { childUri, parentUri } = require('../../../fs/file-system');
const { paths } = require('../../../paths');
const { failure } = require('../../../errors');
const { isAbort } = require('../../../jobs');

/**
 * Copying, moving and linking entries into a directory (2.7), with what to do about a name already there
 * asked of the caller — the conflict prompt, for a pane. Kept apart from the pane, which runs them.
 *
 * A directory onto a directory is merged when overwriting: its entries go in one by one, each conflict
 * asked about in turn, as Explorer does, instead of replacing the whole directory.
 *
 * Run as a job (2.10), a transfer tells how it goes (`progress`) in bytes, against the entries' total size,
 * added up meanwhile (`measure()`) — so a move that only renames needn't wait for it — and stops when its
 * `signal` is aborted, with `cancelled` set.
 */

/**
 * @typedef {InstanceType<typeof import('../../../fs/file-system').FileSystem>} FileSystem
 * @typedef {import('../../../fs/file-system').FileStat} FileStat
 * @typedef {'copy' | 'move' | 'link'} Mode
 */

/**
 * What to do about a name taken at the destination: `overwrite` replaces what's there — or merges a
 * directory into a directory — `skip` leaves both as they are, `keepBoth` gives the new entry a free name
 * (`notes (2).txt`), and `cancel` stops the whole operation.
 * @typedef {'overwrite' | 'skip' | 'keepBoth' | 'cancel'} Action
 */

/**
 * @typedef {object} Resolution
 * @property {Action} action
 * @property {boolean} [all] Do the same for every conflict after this one.
 */

/**
 * A name taken at the destination.
 * @typedef {object} Conflict
 * @property {string} name
 * @property {string} directory Where it's taken, as a URI.
 * @property {FileStat} source
 * @property {FileStat} target
 * @property {boolean} merge Whether overwriting merges — both are directories.
 */

/**
 * @typedef {(conflict: Conflict) => Promise<Resolution>} Resolve
 */

/**
 * How it went.
 * @typedef {object} Outcome
 * @property {string[]} created The names now in the destination for each entry done — a new name when
 *   kept both — in the order given.
 * @property {string[]} done The URIs of the entries done, as given — `created[i]` is `done[i]`'s new name.
 * @property {number} skipped Entries left alone: skipped, or moved where they already are.
 * @property {unknown[]} failures An error for each entry that failed; the others went on.
 * @property {boolean} cancelled Whether a conflict was answered with `cancel`, or the signal aborted,
 *   stopping the rest.
 */

/**
 * How a transfer is going, in bytes: `name` is the top-level entry it's on, `item` how many it has done.
 * `total` is `null` until the sizes are added up.
 * @typedef {object} Progress
 * @property {string} name
 * @property {number} item
 * @property {number} done
 * @property {number | null} total
 */

/** Thrown to stop a transfer when a conflict is answered with `cancel`. */
const CANCEL = Symbol('cancel');

/**
 * @param {FileSystem} fs
 * @param {string} uri
 * @returns {Promise<FileStat | null>} `null` if nothing is there.
 */
async function statOrNull(fs, uri) {
  try {
    return await fs.stat(uri);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/** Entries `measure()` stats at once. */
const MEASURE_BATCH = 64;

/**
 * The size of an entry — a directory's is its files', at any depth; a symlink counts as nothing.
 * @param {FileSystem} fs
 * @param {string} uri
 * @param {AbortSignal} signal Stops it, with an abort.
 * @returns {Promise<number>} In bytes.
 */
async function measure(fs, uri, signal) {
  signal.throwIfAborted();
  const stat = await fs.stat(uri);
  if (stat.symlink) {
    return 0;
  }
  if (stat.type !== 'directory') {
    return stat.size;
  }
  const entries = await fs.readDirectory(uri);
  let size = 0;
  for (let i = 0; i < entries.length; i += MEASURE_BATCH) {
    const sizes = await Promise.all(entries.slice(i, i + MEASURE_BATCH).map((entry) => measure(fs, childUri(uri, entry.name), signal)));
    size += sizes.reduce((sum, one) => sum + one, 0);
  }
  return size;
}

/**
 * The same name with ` (2)`, ` (3)`, … before its extension — `notes (2).txt`, `src (2)` for a directory,
 * `.bashrc (2)` — the first one free in the directory.
 * @param {FileSystem} fs
 * @param {string} directory A URI.
 * @param {string} name
 * @param {boolean} directoryEntry Whether the entry named is a directory, which has no extension.
 * @returns {Promise<string>}
 */
async function freeName(fs, directory, name, directoryEntry) {
  const dot = name.lastIndexOf('.');
  const cut = directoryEntry || dot <= 0 ? name.length : dot;
  for (let n = 2; ; n++) {
    const candidate = `${name.slice(0, cut)} (${n})${name.slice(cut)}`;
    if (!await statOrNull(fs, childUri(directory, candidate))) {
      return candidate;
    }
  }
}

/**
 * A URI's local path, to compare — case folded on Windows, whose file systems ignore it.
 * @param {string} uri
 * @returns {string | null} `null` if it isn't a local file.
 */
function localPath(uri) {
  try {
    const path = paths.fromUri(uri);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  } catch {
    return null;
  }
}

/**
 * The URI to compare: a local file's path, or else the URI without a trailing `/`.
 * @param {string} uri
 * @returns {string}
 */
function comparable(uri) {
  return localPath(uri) ?? uri.replace(/\/+$/, '');
}

/**
 * Whether `uri` is `directory` or inside it.
 * @param {string} uri
 * @param {string} directory
 * @returns {boolean}
 */
function within(uri, directory) {
  const inner = localPath(uri);
  const outer = localPath(directory);
  if (inner === null || outer === null) {
    const [a, b] = [comparable(uri), comparable(directory)];
    return a === b || a.startsWith(`${b}/`);
  }
  const relative = nodePath.relative(outer, inner);
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

/**
 * Whether two URIs are the same entry — by path, for local files.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function same(a, b) {
  return comparable(a) === comparable(b);
}

/**
 * Copies, moves or links entries into a directory. A conflict is resolved by `resolve`, or by the answer
 * it gave for all; an entry copied into the directory it's in is kept next to itself (`notes (2).txt`)
 * without asking, and one moved there is left alone.
 * @param {FileSystem} fs
 * @param {object} options
 * @param {Mode} options.mode
 * @param {(string | { uri: string, name: string })[]} options.sources URIs — or URIs with the names to give
 *   them, as restoring from the trash does.
 * @param {string} options.destination The directory's URI.
 * @param {Resolve} options.resolve
 * @param {AbortSignal} [options.signal] Cancels the rest.
 * @param {(progress: Progress) => void} [options.progress] Called often.
 * @returns {Promise<Outcome>}
 */
async function transfer(fs, { mode, sources, destination, resolve, signal, progress }) {
  /** @type {Outcome} */
  const outcome = { created: [], done: [], skipped: 0, failures: [], cancelled: false };
  /** @type {Action | null} */
  let policy = null;
  const items = sources.map((item) => (typeof item === 'string' ? { uri: item, name: parentUri(item)?.name } : item));

  // Progress: bytes of the entries done — their sizes once known, else the bytes copied for them — plus
  // the one under way.
  let item = 0;
  let current = 0;
  let finished = 0;
  /** @type {number[]} Bytes copied for each entry done. */
  const copied = [];
  /** @type {number[] | null} */
  let sizes = null;
  /** @type {number | null} */
  let total = null;
  const measuring = new AbortController();
  const report = () => progress?.({ name: (items[item] ?? items.at(-1))?.name ?? '', item, done: finished + current, total });
  if (progress && mode !== 'link') {
    Promise.all(items.map(({ uri }) => measure(fs, uri, measuring.signal).catch((error) => (isAbort(error) ? Promise.reject(error) : 0))))
      .then((measured) => {
        sizes = measured;
        total = measured.reduce((sum, size) => sum + size, 0);
        finished = copied.reduce((sum, _, i) => sum + measured[i], 0);
        report();
      })
      .catch(() => {});
  }
  /** @param {number} bytes */
  const count = (bytes) => {
    current += bytes;
    report();
  };
  const options = { signal, progress: progress && count };

  /** @param {Conflict} conflict */
  const decide = async (conflict) => {
    if (policy) {
      return policy;
    }
    const { action, all = false } = await resolve(conflict);
    if (action === 'cancel') {
      throw CANCEL;
    }
    if (all) {
      policy = action;
    }
    return action;
  };

  /**
   * Puts one entry into a directory.
   * @param {string} source
   * @param {string} directory
   * @param {string} name
   * @returns {Promise<string | null>} The name it has there, or `null` if left alone.
   */
  const one = async (source, directory, name) => {
    signal?.throwIfAborted();
    const from = parentUri(source);
    const home = from !== null && same(from.uri, directory);
    if (mode === 'move' && home) {
      return null;
    }
    const stat = await fs.stat(source);
    const tree = stat.type === 'directory' && !stat.symlink;
    if (mode !== 'link' && tree && within(directory, source)) {
      throw failure(`Can't ${mode} ${name} into itself`);
    }
    let target = childUri(directory, name);
    const existing = await statOrNull(fs, target);
    let overwrite = false;
    if (existing) {
      const merge = mode !== 'link' && tree && existing.type === 'directory' && !existing.symlink;
      const action = home ? 'keepBoth' : await decide({ name, directory, source: stat, target: existing, merge });
      if (action === 'skip') {
        return null;
      }
      if (action === 'keepBoth') {
        name = await freeName(fs, directory, name, stat.type === 'directory');
        target = childUri(directory, name);
      } else if (merge) {
        await mergeInto(source, target);
        return name;
      } else {
        overwrite = true;
      }
    }
    if (mode === 'copy') {
      await fs.copy(source, target, { overwrite, ...options });
    } else if (mode === 'move') {
      await fs.rename(source, target, { overwrite, ...options });
    } else {
      if (overwrite) {
        await fs.delete(target, { recursive: true });
      }
      await fs.createSymlink(target, source);
    }
    return name;
  };

  /**
   * Puts a directory's entries into another, one by one; a moved one is then deleted, if nothing was left
   * in it.
   * @param {string} source
   * @param {string} target
   */
  const mergeInto = async (source, target) => {
    for (const entry of await fs.readDirectory(source)) {
      try {
        if (await one(childUri(source, entry.name), target, entry.name) === null) {
          outcome.skipped++;
        }
      } catch (error) {
        if (error === CANCEL || (signal?.aborted && isAbort(error))) {
          throw error;
        }
        outcome.failures.push(error);
      }
    }
    if (mode === 'move') {
      try {
        await fs.delete(source);
      } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOTEMPTY') {
          throw error;
        }
      }
    }
  };

  try {
    for (; item < items.length; item++) {
      const { uri: source, name } = items[item];
      report();
      try {
        if (name === undefined) {
          throw failure(`Can't ${mode} ${paths.displayUri(source)}: it's a root`);
        }
        const created = await one(source, destination, name);
        if (created === null) {
          outcome.skipped++;
        } else {
          outcome.created.push(created);
          outcome.done.push(source);
        }
      } catch (error) {
        if (error === CANCEL || (signal?.aborted && isAbort(error))) {
          outcome.cancelled = true;
          break;
        }
        outcome.failures.push(error);
      }
      copied.push(current);
      finished += sizes ? sizes[item] : current;
      current = 0;
    }
    report();
  } finally {
    measuring.abort();
  }
  return outcome;
}

module.exports = { transfer, measure, freeName, within, same, statOrNull };
