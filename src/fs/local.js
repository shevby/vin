const fs = require('node:fs');
const nodePath = require('node:path');
const { paths } = require('../paths');
const { log } = require('../log');
const { fsError } = require('./file-system');

/**
 * @typedef {import('./file-system').FileSystemProvider} FileSystemProvider
 * @typedef {import('./file-system').FileType} FileType
 * @typedef {import('./file-system').FileStat} FileStat
 * @typedef {import('./file-system').DirectoryEntry} DirectoryEntry
 * @typedef {import('./file-system').FileChange} FileChange
 */

/**
 * @param {fs.Stats | fs.Dirent} entry
 * @returns {FileType}
 */
function typeOf(entry) {
  return entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other';
}

/**
 * @param {string} path
 * @returns {Promise<fs.BigIntStats | null>} The entry itself (a symlink, not its target), or `null` if nothing
 *   is there. Big integers, as Windows file ids don't fit a number.
 */
async function lstatOrNull(path) {
  try {
    return await fs.promises.lstat(path, { bigint: true });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * The local disk, for `file:` URIs, through Node's `fs`.
 * @implements {FileSystemProvider}
 */
class LocalProvider {
  /** @type {FileSystemProvider['stat']} */
  async stat(uri) {
    const path = paths.fromUri(uri);
    const entry = await fs.promises.lstat(path);
    if (!entry.isSymbolicLink()) {
      return this.#stat(entry, false);
    }
    try {
      return this.#stat(await fs.promises.stat(path), true);
    } catch {
      return { ...this.#stat(entry, true), type: 'unknown' };
    }
  }

  /**
   * @param {fs.Stats} stats
   * @param {boolean} symlink
   * @returns {FileStat}
   */
  #stat(stats, symlink) {
    return { type: typeOf(stats), symlink, size: stats.size, mtime: stats.mtimeMs, ctime: stats.ctimeMs, mode: stats.mode };
  }

  /** @type {FileSystemProvider['readDirectory']} */
  async readDirectory(uri) {
    const path = paths.fromUri(uri);
    const entries = await fs.promises.readdir(path, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      if (!entry.isSymbolicLink()) {
        return { name: entry.name, type: typeOf(entry), symlink: false };
      }
      /** @type {FileType} */
      let type = 'unknown';
      try {
        type = typeOf(await fs.promises.stat(nodePath.join(path, entry.name)));
      } catch {
        // A broken link.
      }
      return { name: entry.name, type, symlink: true };
    }));
  }

  /** @type {FileSystemProvider['createDirectory']} */
  async createDirectory(uri, { recursive = false } = {}) {
    await fs.promises.mkdir(paths.fromUri(uri), { recursive });
  }

  /** @type {FileSystemProvider['readFile']} */
  async readFile(uri) {
    return fs.promises.readFile(paths.fromUri(uri));
  }

  /** @type {FileSystemProvider['writeFile']} */
  async writeFile(uri, data, { overwrite = false } = {}) {
    await fs.promises.writeFile(paths.fromUri(uri), data, { flag: overwrite ? 'w' : 'wx' });
  }

  /** @type {FileSystemProvider['delete']} */
  async delete(uri, { recursive = false } = {}) {
    const path = paths.fromUri(uri);
    const entry = await fs.promises.lstat(path);
    if (!entry.isDirectory()) {
      // A file or a symlink — to a directory too: that removes the link, never what it points to.
      await fs.promises.unlink(path);
    } else if (recursive) {
      await fs.promises.rm(path, { recursive: true });
    } else {
      await fs.promises.rmdir(path);
    }
  }

  /**
   * Makes way at `to` for a rename or copy of `from`.
   * @param {string} from
   * @param {string} to
   * @param {boolean} overwrite
   * @param {string} action For errors, e.g. `rename`.
   * @returns {Promise<boolean>} Whether `to` is `from` itself — the same name in another case, on a file
   *   system that ignores case.
   */
  async #clear(from, to, overwrite, action) {
    const [source, target] = await Promise.all([fs.promises.lstat(from, { bigint: true }), lstatOrNull(to)]);
    if (!target) {
      return false;
    }
    if (target.ino === source.ino && target.dev === source.dev) {
      return true;
    }
    if (!overwrite) {
      throw fsError('EEXIST', `file already exists, ${action} '${from}' -> '${to}'`);
    }
    const inside = nodePath.relative(to, from);
    if (!inside.startsWith('..') && !nodePath.isAbsolute(inside)) {
      throw fsError('EINVAL', `can't replace a directory with what's inside it, ${action} '${from}' -> '${to}'`);
    }
    await fs.promises.rm(to, { recursive: true });
    return false;
  }

  /** @type {FileSystemProvider['rename']} */
  async rename(fromUri, toUri, { overwrite = false } = {}) {
    const from = paths.fromUri(fromUri);
    const to = paths.fromUri(toUri);
    await this.#clear(from, to, overwrite, 'rename');
    try {
      await fs.promises.rename(from, to);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') {
        throw error;
      }
      // Another drive or mount: copy, then delete the original.
      await this.#copy(from, to);
      await fs.promises.rm(from, { recursive: true });
    }
  }

  /** @type {NonNullable<FileSystemProvider['copy']>} */
  async copy(fromUri, toUri, { overwrite = false } = {}) {
    const from = paths.fromUri(fromUri);
    const to = paths.fromUri(toUri);
    if (await this.#clear(from, to, overwrite, 'copy')) {
      throw fsError('EINVAL', `can't copy a file onto itself, copy '${from}' -> '${to}'`);
    }
    await this.#copy(from, to);
  }

  /**
   * @param {string} from
   * @param {string} to Nothing there.
   */
  async #copy(from, to) {
    await fs.promises.cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }

  /** @type {FileSystemProvider['createReadStream']} */
  async createReadStream(uri, { start, end } = {}) {
    const handle = await fs.promises.open(paths.fromUri(uri), 'r');
    return handle.createReadStream({ start, end });
  }

  /** @type {FileSystemProvider['createWriteStream']} */
  async createWriteStream(uri, { overwrite = false } = {}) {
    const handle = await fs.promises.open(paths.fromUri(uri), overwrite ? 'w' : 'wx');
    return handle.createWriteStream();
  }

  /**
   * Built on `fs.watch`, which reports a creation and a deletion alike ("rename"), so each is told apart by
   * whether the entry exists by the time it's checked. If the watched resource goes away, that's reported and
   * watching stops.
   * @type {FileSystemProvider['watch']}
   */
  watch(uri, listener, { recursive = false } = {}) {
    const path = paths.fromUri(uri);
    let closed = false;
    // Existence checks are async; chained, so changes arrive in the order they happened.
    let queue = Promise.resolve();
    /** @param {() => Promise<FileChange | null>} change */
    const report = (change) => {
      queue = queue.then(change).then((event) => {
        if (event && !closed) {
          listener(event);
        }
      }).catch((error) => log.error(`Watching ${path} failed:`, error));
    };
    /** @param {string} target */
    const exists = (target) => lstatOrNull(target).then(Boolean);

    const watcher = fs.watch(path, { recursive, persistent: false }, (event, name) => {
      const target = name ? nodePath.join(path, name) : path;
      const changed = paths.toUri(target);
      report(async () => {
        if (event === 'change') {
          return { type: 'changed', uri: changed };
        }
        return { type: (await exists(target)) ? 'created' : 'deleted', uri: changed };
      });
    });
    watcher.on('error', (error) => {
      watcher.close();
      report(async () => {
        if (await exists(path)) {
          log.error(`Watching ${path} stopped:`, error);
          return null;
        }
        return { type: 'deleted', uri };
      });
    });
    return () => {
      // Changes still being checked are dropped too.
      closed = true;
      watcher.close();
    };
  }
}

module.exports = { LocalProvider };
