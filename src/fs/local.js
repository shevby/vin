const fs = require('node:fs');
const nodePath = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { pipeline } = require('node:stream/promises');
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
  if (entry.isFile()) {
    return 'file';
  }
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isFIFO()) {
    return 'fifo';
  }
  if (entry.isSocket()) {
    return 'socket';
  }
  return entry.isBlockDevice() || entry.isCharacterDevice() ? 'device' : 'other';
}

/**
 * Extensions of the files vin calls executable on Windows: programs and shell scripts. Not `PATHEXT`, which
 * also has the Windows Script Host's (`.js`, `.vbs`, …) and would mark every `.js` file in a project.
 */
const WINDOWS_EXECUTABLES = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1']);

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
 * Files at least this big are copied in chunks, to show progress and stop midway; smaller ones in one go,
 * the OS's fastest way.
 */
const CHUNKED = 8 * 1024 * 1024;

/** The size of each chunk. */
const CHUNK = 1024 * 1024;

/**
 * Copies one file where nothing is, keeping its timestamps — in chunks if it's big and someone wants to
 * know how it goes, so a cancel stops it midway and removes what was written.
 * @param {string} from
 * @param {string} to
 * @param {fs.Stats} stat `from`'s.
 * @param {import('./file-system').TransferOptions} options
 */
async function copyFile(from, to, stat, { signal, progress }) {
  if (stat.size < CHUNKED) {
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  } else {
    const handle = await fs.promises.open(to, 'wx', stat.mode);
    try {
      await pipeline(
        fs.createReadStream(from, { highWaterMark: CHUNK }),
        async function* count(chunks) {
          for await (const chunk of chunks) {
            progress?.(chunk.length);
            yield chunk;
          }
        },
        handle.createWriteStream(),
        { signal },
      );
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.promises.rm(to, { force: true });
      throw error;
    }
  }
  await fs.promises.utimes(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  if (stat.size < CHUNKED) {
    progress?.(stat.size);
  }
}

/** Drive letters. */
const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** How long probing drive letters waits for one that doesn't answer before listing it anyway. */
const PROBE_WAIT = 1000;

/**
 * The drives of Windows, by letter, for the list of drives (2.4) — the local ones and mapped network drives,
 * disconnected ones too, as Explorer shows them. Node has no API for it; `fsutil fsinfo drives` answers in
 * milliseconds and needs no elevation. Should it fail, each letter is probed with `stat`, which answers at
 * once for a letter not in use but can take seconds for a disconnected network drive — one that hasn't
 * answered after `wait` is listed anyway.
 * @param {object} [options] For tests.
 * @param {string[]} [options.command] Lists the drives as `C:\`, `D:\`, ….
 * @param {number} [options.wait] In ms.
 * @param {string[]} [options.letters] The ones to probe, uppercase and in order.
 * @returns {Promise<string[]>} Uppercase letters, in order.
 */
async function listDrives({ command = ['fsutil', 'fsinfo', 'drives'], wait = PROBE_WAIT, letters = LETTERS } = {}) {
  try {
    const [file, ...args] = command;
    const { stdout } = await execFile(file, args, { windowsHide: true, timeout: 5000 });
    const listed = [...stdout.matchAll(/\b([A-Z]):\\/gi)].map(([, letter]) => letter.toUpperCase());
    if (listed.length) {
      return [...new Set(listed)].sort();
    }
  } catch (error) {
    log.debug('Listing drives with fsutil failed, probing them:', error);
  }
  /** @type {Promise<boolean>} */
  const timeout = new Promise((resolve) => setTimeout(resolve, wait, true).unref());
  const found = await Promise.all(letters.map((letter) => Promise.race([
    fs.promises.stat(`${letter}:\\`).then(() => true, (error) => error.code !== 'ENOENT'),
    timeout,
  ])));
  return letters.filter((_, i) => found[i]);
}

/**
 * The local disk, for `file:` URIs, through Node's `fs` — and on Windows, the list of drives above them
 * (`paths.drives`), each a directory named by its letter (`c`).
 * @implements {FileSystemProvider}
 */
class LocalProvider {
  /** Whether executables are told by extension, as on Windows, rather than by execute bits. */
  #byExtension;

  /**
   * @param {object} [options] For tests.
   * @param {NodeJS.Platform} [options.platform] Default: this one.
   */
  constructor({ platform = process.platform } = {}) {
    this.#byExtension = platform === 'win32';
  }

  /** @type {FileSystemProvider['stat']} */
  async stat(uri) {
    if (uri === paths.drives) {
      return { type: 'directory', symlink: false, size: 0, mtime: 0, ctime: 0, executable: false };
    }
    const path = paths.fromUri(uri);
    const entry = await fs.promises.lstat(path);
    if (paths.parent(path) === null) {
      const stat = this.#stat(path, entry, false);
      try {
        const { bavail, bsize } = await fs.promises.statfs(path);
        return { ...stat, free: bavail * bsize };
      } catch {
        return stat;
      }
    }
    if (!entry.isSymbolicLink()) {
      return this.#stat(path, entry, false);
    }
    try {
      return this.#stat(path, await fs.promises.stat(path), true);
    } catch {
      return { ...this.#stat(path, entry, true), type: 'unknown', executable: false };
    }
  }

  /**
   * @param {string} path
   * @param {fs.Stats} stats
   * @param {boolean} symlink
   * @returns {FileStat}
   */
  #stat(path, stats, symlink) {
    const type = typeOf(stats);
    const executable = type === 'file'
      && (this.#byExtension ? WINDOWS_EXECUTABLES.has(nodePath.extname(path).toLowerCase()) : (stats.mode & 0o111) !== 0);
    return { type, symlink, size: stats.size, mtime: stats.mtimeMs, ctime: stats.ctimeMs, mode: stats.mode, executable };
  }

  /** @type {FileSystemProvider['readDirectory']} */
  async readDirectory(uri) {
    if (uri === paths.drives) {
      return (await listDrives()).map((letter) => ({ name: letter.toLowerCase(), type: /** @type {const} */ ('directory'), symlink: false }));
    }
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
   * @returns {Promise<boolean>} Whether `to` is `from` itself — the same name in another case, on a file
   *   system that ignores case.
   */
  async #clear(from, to, overwrite) {
    const [source, target] = await Promise.all([fs.promises.lstat(from, { bigint: true }), lstatOrNull(to)]);
    if (!target) {
      return false;
    }
    if (target.ino === source.ino && target.dev === source.dev) {
      return true;
    }
    if (!overwrite) {
      throw fsError('EEXIST', 'Already exists', { path: from, dest: to });
    }
    const inside = nodePath.relative(to, from);
    if (!inside.startsWith('..') && !nodePath.isAbsolute(inside)) {
      throw fsError('EINVAL', `Can't replace a directory with what's inside it`, { path: from, dest: to });
    }
    await fs.promises.rm(to, { recursive: true });
    return false;
  }

  /** @type {FileSystemProvider['rename']} */
  async rename(fromUri, toUri, { overwrite = false, ...options } = {}) {
    const from = paths.fromUri(fromUri);
    const to = paths.fromUri(toUri);
    await this.#clear(from, to, overwrite);
    try {
      await fs.promises.rename(from, to);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') {
        throw error;
      }
      // Another drive or mount: copy, then delete the original — or, if the copy fails, what it made.
      try {
        await this.#copy(from, to, options);
      } catch (copyError) {
        await fs.promises.rm(to, { recursive: true, force: true }).catch((cleanup) => log.error(`Removing a half-moved ${to}:`, cleanup));
        throw copyError;
      }
      await fs.promises.rm(from, { recursive: true });
    }
  }

  /** @type {NonNullable<FileSystemProvider['copy']>} */
  async copy(fromUri, toUri, { overwrite = false, ...options } = {}) {
    const from = paths.fromUri(fromUri);
    const to = paths.fromUri(toUri);
    if (await this.#clear(from, to, overwrite)) {
      throw fsError('EINVAL', "Can't copy a file onto itself", { path: from, dest: to });
    }
    await this.#copy(from, to, options);
  }

  /**
   * Copies a tree with `fs.cp`, except its files, which `copyFile()` copies as `cp` comes to each, to tell
   * how it goes and to stop between files — or within a big one.
   * @param {string} from
   * @param {string} to Nothing there.
   * @param {Omit<import('./file-system').TransferOptions, 'overwrite'>} options
   */
  async #copy(from, to, options) {
    const { signal } = options;
    await fs.promises.cp(from, to, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: async (source, target) => {
        signal?.throwIfAborted();
        const stat = await fs.promises.lstat(source);
        if (!stat.isFile()) {
          return true;
        }
        await copyFile(source, target, stat, options);
        return false;
      },
    });
  }

  /**
   * On Windows a symlink needs Developer Mode or admin rights; without them, a link to a directory is made
   * a junction instead, which works the same for local directories and needs neither.
   * @type {NonNullable<FileSystemProvider['createSymlink']>}
   */
  async createSymlink(uri, targetUri) {
    const path = paths.fromUri(uri);
    const target = paths.fromUri(targetUri);
    // Windows checks the rights first, and would fail with EPERM.
    if (await lstatOrNull(path)) {
      throw fsError('EEXIST', 'Already exists', { path: target, dest: path });
    }
    if (!this.#byExtension) {
      await fs.promises.symlink(target, path);
      return;
    }
    const directory = (await fs.promises.stat(target)).isDirectory();
    try {
      await fs.promises.symlink(target, path, directory ? 'dir' : 'file');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EPERM') {
        throw error;
      }
      if (!directory) {
        throw fsError('EPERM', 'Creating symlinks on Windows needs Developer Mode or admin rights', { path: target, dest: path });
      }
      await fs.promises.symlink(target, path, 'junction');
    }
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

module.exports = { LocalProvider, listDrives };
