const fs = require('node:fs');
const path = require('node:path');
const { failure } = require('./errors');
const { paths } = require('./paths');
const { ROOT, volatile } = require('./volatile');

/**
 * vin's trash (2.7, 2.9) — off unless `pane.trash` is on, as the user chose: deleting is permanent
 * otherwise, and there's no OS recycle bin. Deleted entries are moved to a directory, `.vin/trash` or the
 * one `pane.trashDirectory` names, shown as `/trash` through the `trash:` scheme (`src/fs/trash.js`:
 * `trash:///notes.txt` is `<directory>/notes.txt`). Where each came from is recorded in `.vin/trash.json`
 * — by its path in the trash, so records outlast a change of directory — to restore it there.
 */

/** The trash's root, as a URI. */
const TRASH_URI = 'trash:///';

/**
 * @typedef {object} TrashRecord
 * @property {string} path Where it was, native.
 * @property {number} deleted When it was deleted, in ms since the epoch.
 */

/**
 * The trash, one per `Vin`; handlers reach it as `this.trash`.
 */
class Trash {
  /** @type {{ get(id: string): unknown }} */
  #config;

  /**
   * @param {object} options
   * @param {{ get(id: string): unknown }} options.config Reads `pane.trash` and `pane.trashDirectory`.
   */
  constructor({ config }) {
    this.#config = config;
  }

  /** Whether deleting moves entries to the trash (`pane.trash`). */
  get enabled() {
    return this.#config.get('pane.trash') === true;
  }

  /**
   * The directory the trash keeps entries in.
   * @returns {string} Native, absolute.
   * @throws {Error} A failure, if the trash is off or `pane.trashDirectory` isn't a path.
   */
  directory() {
    if (!this.enabled) {
      throw failure('The trash is off: turn on pane.trash in the config');
    }
    const set = /** @type {string} */ (this.#config.get('pane.trashDirectory'));
    if (!set) {
      return path.join(volatile.directory, 'trash');
    }
    try {
      return paths.resolve(set, ROOT);
    } catch (error) {
      throw failure(`pane.trashDirectory in the config isn't a path: ${/** @type {Error} */ (error).message}`);
    }
  }

  /**
   * The `file:` URI of a `trash:` one: `trash:///a%20b/c` is `<directory>/a b/c`.
   * @param {string} uri
   * @returns {string}
   * @throws {Error} A failure, if the trash is off; a `TypeError` for another scheme.
   */
  real(uri) {
    const url = new URL(uri);
    if (url.protocol !== 'trash:') {
      throw new TypeError(`"${uri}" isn't in the trash`);
    }
    const names = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    return paths.toUri(path.join(this.directory(), ...names));
  }

  /**
   * Whether an entry is in the trash — by `trash:` URI, or by its path in the trash's directory.
   * @param {string} uri
   * @returns {boolean}
   */
  contains(uri) {
    if (/^trash:/i.test(uri)) {
      return true;
    }
    if (!this.enabled) {
      return false;
    }
    try {
      const relative = path.relative(this.directory(), paths.fromUri(uri));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    } catch {
      return false;
    }
  }

  /**
   * Records where an entry in the trash came from.
   * @param {string} uri In the trash — `trash:` or `file:`.
   * @param {string} origin Where it was, as a URI.
   */
  record(uri, origin) {
    const records = this.#read();
    records[this.#key(uri)] = { path: paths.fromUri(origin), deleted: Date.now() };
    this.#write(records);
  }

  /**
   * @param {string} uri In the trash.
   * @returns {string | null} Where it came from, as a URI, if that's recorded.
   */
  origin(uri) {
    const record = this.#read()[this.#key(uri)];
    return record ? paths.toUri(record.path) : null;
  }

  /**
   * Drops the records of entries gone from the trash — restored, or deleted for good.
   * @param {string[]} uris In the trash.
   */
  forget(uris) {
    const records = this.#read();
    const before = Object.keys(records).length;
    for (const uri of uris) {
      delete records[this.#key(uri)];
    }
    if (Object.keys(records).length !== before) {
      this.#write(records);
    }
  }

  /**
   * @param {string} uri
   * @returns {string} The native path the records know an entry by.
   */
  #key(uri) {
    return paths.fromUri(/^trash:/i.test(uri) ? this.real(uri) : uri);
  }

  /** The records' file. */
  get #file() {
    return path.join(volatile.directory, 'trash.json');
  }

  /**
   * @returns {{ [path: string]: TrashRecord }} None if there's no file yet.
   * @throws {Error} A failure, if the file can't be read or isn't JSON.
   */
  #read() {
    let text;
    try {
      text = fs.readFileSync(this.#file, 'utf8');
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
        return {};
      }
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw failure(`The trash's records in ${paths.display(this.#file)} aren't JSON; fix or delete the file`);
    }
  }

  /**
   * Writes the records through a temporary file, so a crash never leaves half of them.
   * @param {{ [path: string]: TrashRecord }} records
   */
  #write(records) {
    fs.mkdirSync(volatile.directory, { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`);
    fs.renameSync(temporary, this.#file);
  }
}

module.exports = { Trash, TRASH_URI };
