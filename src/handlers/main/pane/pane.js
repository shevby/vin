const Handler = require('../../../handler');
const { childUri } = require('../../../fs/file-system');

/** @typedef {import('../../../fs/file-system').FileType} FileType */

/**
 * One row of the listing. Its details come after the listing itself, from a `stat` of each entry, so a huge
 * directory shows at once; until then they're `null` (and `executable` is `false`).
 * @typedef {object} Entry
 * @property {string} name
 * @property {FileType} type For a symlink, its target's — `unknown` if it's broken.
 * @property {boolean} symlink
 * @property {boolean} executable
 * @property {number | null} size In bytes.
 * @property {number | null} mtime Last modified, in ms since the epoch.
 */

/**
 * `loading` until the directory is read; `failed` if it couldn't be (the error is reported).
 * @typedef {'loading' | 'ready' | 'failed'} Status
 */

/** Entries whose details are fetched at once — and sent to the UI as one update. */
const STAT_BATCH = 256;

/** Natural order (`file2` before `file10`), ignoring case and accents. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * The listing's order until sorting is configurable (2.11): directories first — symlinks to them too —
 * then by name, in natural order; names equal but for case or accents in code-point order, so the order
 * is stable.
 * @param {Pick<Entry, 'name' | 'type'>} a
 * @param {Pick<Entry, 'name' | 'type'>} b
 * @returns {number}
 */
function compareEntries(a, b) {
  const directories = Number(b.type === 'directory') - Number(a.type === 'directory');
  return directories || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/**
 * One pane of the main window (`src/handlers/main/`): a view of one directory, addressed by URI so a pane
 * can later show any provider's files (`src/fs/`). It lists the directory (`entries`) with a cursor on one
 * of them (`cursor`, an index); moving it and navigation come with 2.3.
 * @extends {Handler<{ uri: string, status: Status, entries: Entry[], cursor: number }>}
 */
class Pane extends Handler {
  static kind = 'pane';

  /** @type {import('../../../contributions').Contributes} */
  static contributes = {
    // papercolor-dark, from vifm-colors; see src/colors.js.
    colors: [
      { key: 'title', default: { fg: 71, bg: 235, bold: true }, description: "The other pane's directory, in its top border (vifm: TopLine)." },
      { key: 'titleActive', default: { fg: 234, bg: 149, bold: true }, description: "The active pane's directory (vifm: TopLineSel)." },
      { key: 'cursor', default: { bold: true, bg: 235 }, description: "The cursor's line in the other pane (vifm: OtherLine)." },
      { key: 'cursorActive', default: { bold: true, inverse: true }, description: "The cursor's line in the active pane (vifm: CurrLine)." },
      { key: 'directory', default: { fg: 74, bold: true }, description: 'Directories (vifm: Directory).' },
      { key: 'link', default: { fg: 173 }, description: 'Symlinks (vifm: Link).' },
      { key: 'brokenLink', default: { fg: 160 }, description: 'Symlinks whose target is missing (vifm: BrokenLink).' },
      { key: 'executable', default: { fg: 70, bold: true }, description: 'Files the OS would run (vifm: Executable).' },
      { key: 'fifo', default: { fg: 74 }, description: 'Named pipes (vifm: Fifo).' },
      { key: 'socket', default: { fg: 140, bold: true }, description: 'Sockets (vifm: Socket).' },
      { key: 'device', default: { fg: 125 }, description: 'Block and character devices (vifm: Device).' },
    ],
  };

  /** @type {string} */
  #uri;
  /** Counts listings started, so one outdated by a newer one — or by disposal — stops touching state. */
  #generation = 0;
  /** @type {Promise<void>} */
  #loading = Promise.resolve();

  /**
   * @param {string} name `left` or `right`, in the main window.
   * @param {object} options
   * @param {string} options.uri The directory it shows, e.g. `file:///C:/Users/me`.
   * @throws {TypeError} If `uri` isn't a URI.
   */
  constructor(name, { uri }) {
    super(name);
    if (typeof uri !== 'string' || !/^[a-z][a-z\d+.-]*:/i.test(uri)) {
      throw new TypeError(`Pane "${name}" needs a directory URI, got ${JSON.stringify(uri)}`);
    }
    this.#uri = uri;
  }

  onInit() {
    this.update({ uri: this.#uri, status: 'loading', entries: [], cursor: 0 });
    // Not awaited: vin starts while the directory is read.
    this.#loading = this.#load();
  }

  onDispose() {
    this.#generation++;
  }

  /**
   * Resolves once the directory is listed and every entry's details are in, or listing it failed.
   * @returns {Promise<void>}
   */
  get loaded() {
    return this.#loading;
  }

  /**
   * Lists the directory, then fetches its entries' details in batches from the top, each batch one update.
   * A failure to list is reported; an entry that can't be read (gone since, or no permission) keeps no
   * details.
   */
  async #load() {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    const { uri } = this.state;
    /** @type {import('../../../fs/file-system').DirectoryEntry[]} */
    let listed;
    try {
      listed = await this.fs.readDirectory(uri);
    } catch (error) {
      if (current()) {
        this.state.status = 'failed';
        this.report(error);
      }
      return;
    }
    if (!current()) {
      return;
    }
    const entries = listed
      .map(({ name, type, symlink }) => ({ name, type, symlink, executable: false, size: null, mtime: null }))
      .sort(compareEntries);
    Object.assign(this.state, { status: 'ready', entries, cursor: 0 });
    for (let start = 0; start < entries.length; start += STAT_BATCH) {
      const batch = entries.slice(start, start + STAT_BATCH);
      const stats = await Promise.all(batch.map((entry) => this.fs.stat(childUri(uri, entry.name)).catch(() => null)));
      if (!current()) {
        return;
      }
      stats.forEach((stat, i) => {
        if (stat) {
          Object.assign(this.state.entries[start + i], { size: stat.size, mtime: stat.mtime, executable: stat.executable });
        }
      });
    }
  }
}

module.exports = Pane;
