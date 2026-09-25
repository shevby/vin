/**
 * File access for every protocol through one interface, modeled on VS Code's `FileSystemProvider`.
 *
 * A resource is addressed by a URI string — `file:///C:/Users/me`, later `sftp://host/home/me` — whose
 * scheme picks the provider; strings, so they can sit in handler state. For local paths, `paths.toUri()`
 * and `paths.fromUri()` (`src/paths.js`) convert.
 *
 * Failures are errors with the `code` Node's `fs` would use — `ENOENT`, `EEXIST`, `ENOTDIR`, `EISDIR`,
 * `ENOTEMPTY`, `EACCES`, `EPERM`, `EBUSY`, `EXDEV` — whatever the protocol, so callers handle them once.
 */

const { paths } = require('../paths');

/**
 * `device` is a block or character device; `other` is anything else, where a protocol can't say more;
 * `unknown` is a symlink whose target is missing or unreadable.
 * @typedef {'file' | 'directory' | 'fifo' | 'socket' | 'device' | 'other' | 'unknown'} FileType
 */

/**
 * What a resource is. For a symlink, it describes the target, with `symlink: true`.
 * @typedef {object} FileStat
 * @property {FileType} type
 * @property {boolean} symlink
 * @property {number} size In bytes.
 * @property {number} mtime Last modified, in ms since the epoch.
 * @property {number} ctime Last status change, in ms since the epoch.
 * @property {number} [mode] Unix permission bits and file type, where the protocol has them.
 * @property {boolean} executable Whether it's a program or script to run: on Unix, a file with an execute
 *   bit; on Windows, one named `.exe`, `.com`, `.bat`, `.cmd`, or `.ps1`.
 * @property {number} [free] For a root — a drive, a share, `/` — the bytes free on it, where the protocol
 *   can tell.
 */

/**
 * One entry of a directory, typed without a full `stat` — enough to sort directories first and draw
 * markers, so a huge directory lists fast (2.2).
 * @typedef {object} DirectoryEntry
 * @property {string} name
 * @property {FileType} type For a symlink, its target's.
 * @property {boolean} symlink
 */

/**
 * A change `watch` reports. Several may come for one operation; debouncing is the caller's.
 * @typedef {object} FileChange
 * @property {'created' | 'changed' | 'deleted'} type
 * @property {string} uri
 */

/**
 * @typedef {object} OverwriteOptions
 * @property {boolean} [overwrite] Replace what's at the target, if anything; else fail with `EEXIST`.
 *   Default: false.
 */

/**
 * The interface a protocol implements. Every method takes absolute URIs of its own scheme.
 * - `createDirectory` (unless `recursive`), `writeFile`, and `createWriteStream` need the parent to exist
 *   (`ENOENT`).
 * - `delete` of a non-empty directory needs `recursive` (`ENOTEMPTY`); a symlink is deleted, never its target.
 * - `rename` and `copy` take a whole tree; changing only the case of a name is a rename, never an overwrite.
 * - `copy` is optional: a protocol without a server-side copy leaves it out, and the caller streams instead.
 * - `createSymlink` is optional too, for protocols without links.
 * - Streams are Node streams, opened before they're returned, so a missing file or an existing target
 *   rejects the promise instead of erroring the stream later.
 * @typedef {object} FileSystemProvider
 * @property {(uri: string) => Promise<FileStat>} stat
 * @property {(uri: string) => Promise<DirectoryEntry[]>} readDirectory In no particular order.
 * @property {(uri: string, options?: { recursive?: boolean }) => Promise<void>} createDirectory `recursive`
 *   creates missing parents too, and succeeds if the directory exists.
 * @property {(uri: string) => Promise<Uint8Array>} readFile
 * @property {(uri: string, data: Uint8Array | string, options?: OverwriteOptions) => Promise<void>} writeFile
 *   A string is written as UTF-8.
 * @property {(uri: string, options?: { recursive?: boolean }) => Promise<void>} delete
 * @property {(from: string, to: string, options?: OverwriteOptions) => Promise<void>} rename
 * @property {(from: string, to: string, options?: OverwriteOptions) => Promise<void>} [copy]
 * @property {(uri: string, target: string) => Promise<void>} [createSymlink] Creates a symlink at `uri` to
 *   `target`, a URI of the same provider; the link holds the target's absolute path. Fails with `EEXIST` if
 *   anything is at `uri`.
 * @property {(uri: string, options?: { start?: number, end?: number }) => Promise<import('node:stream').Readable>}
 *   createReadStream `start` and `end` are byte offsets, both inclusive, as in `fs.createReadStream`.
 * @property {(uri: string, options?: OverwriteOptions) => Promise<import('node:stream').Writable>} createWriteStream
 * @property {(uri: string, listener: (change: FileChange) => void, options?: { recursive?: boolean }) => () => void}
 *   watch Reports changes to the resource, or to a directory's entries (with `recursive`, at any depth);
 *   returns the function that stops watching.
 */

/**
 * An error shaped like Node's `fs` errors — `code`, and the `path` and `dest` it concerns — plus the
 * `reason` in words for the user, which `describeError()` (`src/errors.js`) shows instead of the code's
 * generic one.
 * @param {string} code E.g. `EEXIST`.
 * @param {string} reason E.g. `Can't copy a file onto itself`.
 * @param {{ path?: string, dest?: string }} [where] Paths or URIs.
 * @returns {Error & { code: string, reason: string, path?: string, dest?: string }}
 */
function fsError(code, reason, where = {}) {
  const quoted = [where.path, where.dest].filter((item) => item !== undefined).map((item) => `'${item}'`);
  const message = `${code}: ${reason}${quoted.length ? `, ${quoted.join(' -> ')}` : ''}`;
  return Object.assign(new Error(message), { code, reason }, where);
}

/**
 * The URI of a directory's entry, whatever the scheme: `childUri('file:///C:/a', 'b c')` is
 * `file:///C:/a/b%20c`.
 * @param {string} uri The directory's.
 * @param {string} name One name, e.g. one `readDirectory` listed.
 * @returns {string}
 */
function childUri(uri, name) {
  return `${uri.endsWith('/') ? uri : `${uri}/`}${encodeURIComponent(name)}`;
}

/**
 * The directory containing a resource, and the resource's name in it: `parentUri('file:///C:/a/b%20c')` is
 * `{ uri: 'file:///C:/a', name: 'b c' }`. A `file:` URI goes by this OS's path rules (`src/paths.js`), so
 * `file:///` and `file://server/share/` are roots — and on Windows, `file:///C:/` is `c` in the list of
 * drives, `file:///`; any other scheme by its path's segments.
 * @param {string} uri
 * @returns {{ uri: string, name: string } | null} `null` for a root.
 */
function parentUri(uri) {
  if (/^file:/i.test(uri)) {
    let path;
    try {
      path = paths.fromUri(uri);
    } catch {
      // Not a path on this OS: by its segments, as below.
    }
    if (path !== undefined) {
      const parent = paths.parent(path);
      if (parent !== null) {
        return { uri: paths.toUri(parent), name: paths.basename(path) };
      }
      const drive = paths.driveName(path);
      return drive === null || paths.drives === null ? null : { uri: paths.drives, name: drive };
    }
  }
  const url = new URL(uri);
  const trimmed = url.pathname.replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  const cut = trimmed.lastIndexOf('/');
  const name = decodeURIComponent(trimmed.slice(cut + 1));
  url.pathname = trimmed.slice(0, cut) || '/';
  url.search = '';
  url.hash = '';
  return { uri: url.href, name };
}

/** A URI's scheme: a letter, then letters, digits, `+`, `-` or `.` (RFC 3986). */
const SCHEME = /^([a-z][a-z\d+.-]*):/i;

/**
 * The file system handlers use (`this.fs`): each call goes to the provider registered for its URI's scheme.
 * `Vin` registers the local disk as `file`.
 * @implements {FileSystemProvider}
 */
class FileSystem {
  /** @type {Map<string, FileSystemProvider>} */
  #providers = new Map();

  /**
   * @param {string} scheme E.g. `file`, `sftp`; any case.
   * @param {FileSystemProvider} provider
   * @returns {() => void} Unregisters it.
   * @throws {Error} If the scheme is malformed or taken.
   */
  register(scheme, provider) {
    const key = scheme.toLowerCase();
    if (!SCHEME.test(`${key}:`) || key.includes(':')) {
      throw new TypeError(`Invalid URI scheme "${scheme}"`);
    }
    if (this.#providers.has(key)) {
      throw new Error(`The "${key}" scheme already has a file system provider`);
    }
    this.#providers.set(key, provider);
    return () => {
      if (this.#providers.get(key) === provider) {
        this.#providers.delete(key);
      }
    };
  }

  /**
   * @param {string} uri
   * @returns {FileSystemProvider} The provider for its scheme.
   * @throws {Error} With code `ENOPROVIDER`, if no provider handles it.
   * @throws {TypeError} If `uri` isn't a URI — a path passed by mistake.
   */
  provider(uri) {
    const scheme = SCHEME.exec(uri)?.[1];
    if (!scheme) {
      throw new TypeError(`"${uri}" isn't a URI; a path needs paths.toUri()`);
    }
    const provider = this.#providers.get(scheme.toLowerCase());
    if (!provider) {
      throw fsError('ENOPROVIDER', `No file system for "${scheme}:"`, { path: uri });
    }
    return provider;
  }

  /**
   * The provider for both URIs — moving between providers is 5.5's streamed copy.
   * @param {string} from
   * @param {string} to
   * @param {string} action For the error, e.g. `copy`.
   */
  #same(from, to, action) {
    const provider = this.provider(from);
    if (this.provider(to) !== provider) {
      throw fsError('EXDEV', `Can't ${action} between file systems yet`, { path: from, dest: to });
    }
    return provider;
  }

  /** @type {FileSystemProvider['stat']} */
  async stat(uri) {
    return this.provider(uri).stat(uri);
  }

  /** @type {FileSystemProvider['readDirectory']} */
  async readDirectory(uri) {
    return this.provider(uri).readDirectory(uri);
  }

  /** @type {FileSystemProvider['createDirectory']} */
  async createDirectory(uri, options) {
    return this.provider(uri).createDirectory(uri, options);
  }

  /** @type {FileSystemProvider['readFile']} */
  async readFile(uri) {
    return this.provider(uri).readFile(uri);
  }

  /** @type {FileSystemProvider['writeFile']} */
  async writeFile(uri, data, options) {
    return this.provider(uri).writeFile(uri, data, options);
  }

  /** @type {FileSystemProvider['delete']} */
  async delete(uri, options) {
    return this.provider(uri).delete(uri, options);
  }

  /** @type {FileSystemProvider['rename']} */
  async rename(from, to, options) {
    return this.#same(from, to, 'move').rename(from, to, options);
  }

  /**
   * Copies a file or a tree, with the provider's own copy where it has one.
   * @type {NonNullable<FileSystemProvider['copy']>}
   */
  async copy(from, to, options) {
    const provider = this.#same(from, to, 'copy');
    if (!provider.copy) {
      // Streaming within one provider joins streaming between providers, in 2.10 and 5.5.
      throw fsError('ENOSYS', "This file system can't copy yet", { path: from, dest: to });
    }
    return provider.copy(from, to, options);
  }

  /**
   * @type {NonNullable<FileSystemProvider['createSymlink']>}
   */
  async createSymlink(uri, target) {
    const provider = this.#same(target, uri, 'link');
    if (!provider.createSymlink) {
      throw fsError('ENOSYS', "This file system has no symlinks", { path: target, dest: uri });
    }
    return provider.createSymlink(uri, target);
  }

  /** @type {FileSystemProvider['createReadStream']} */
  async createReadStream(uri, options) {
    return this.provider(uri).createReadStream(uri, options);
  }

  /** @type {FileSystemProvider['createWriteStream']} */
  async createWriteStream(uri, options) {
    return this.provider(uri).createWriteStream(uri, options);
  }

  /** @type {FileSystemProvider['watch']} */
  watch(uri, listener, options) {
    return this.provider(uri).watch(uri, listener, options);
  }
}

module.exports = { FileSystem, childUri, parentUri, fsError };
