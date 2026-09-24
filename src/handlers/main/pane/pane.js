const Handler = require('../../../handler');
const { childUri, parentUri } = require('../../../fs/file-system');
const { paths } = require('../../../paths');
const { failure } = require('../../../errors');
const { opener } = require('../../../open');

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
 * @property {number} [free] For a root — a drive in the list of drives (2.4) — the bytes free on it, once
 *   known.
 */

/**
 * `loading` until the first directory is read; `failed` if it couldn't be (the error is reported).
 * @typedef {'loading' | 'ready' | 'failed'} Status
 */

/**
 * @typedef {object} PaneState
 * @property {string} uri The directory shown.
 * @property {Status} status
 * @property {Entry[]} entries
 * @property {number} cursor
 * @property {string[]} selected Names selected, in listing order — without the group range's.
 * @property {number | null} range While selecting a group, the entry it started at; the range spans from
 *   there to the cursor.
 */

/**
 * How a listing ended: shown, failed (and reported), or dropped for a newer one — or for disposal.
 * @typedef {'listed' | 'failed' | 'superseded'} Outcome
 */

/** Entries whose details are fetched at once — and sent to the UI as one update. */
const STAT_BATCH = 256;

/** How long, in ms, a batch of details waits before showing what has come, while an entry is slow. */
const SLOW_STAT = 200;

/** Directories a pane's history keeps, as a browser's does. */
const HISTORY_SIZE = 100;

/** Directories a pane remembers its cursor in, so coming back puts it where it was. */
const POSITIONS_SIZE = 1000;

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
 * A `file:` URI as `paths.toUri()` writes it, so a directory has one URI however it was reached
 * (`childUri()` escapes more than `toUri()` does); any other URI as it is.
 * @param {string} uri
 * @returns {string}
 */
function canonical(uri) {
  if (/^file:/i.test(uri)) {
    try {
      return paths.toUri(paths.fromUri(uri));
    } catch {
      // Not a path on this OS: left as it is.
    }
  }
  return uri;
}

/**
 * One pane of the main window (`src/handlers/main/`): a view of one directory, addressed by URI so a pane
 * can later show any provider's files (`src/fs/`). It lists the directory (`entries`) with a cursor on one
 * of them (`cursor`, an index), and moves between directories (2.3): into the one under the cursor, up to
 * the parent — with the cursor on the directory it came from — home, or back and forward through its
 * history, as a browser does. A directory it comes back to gets its cursor where it was left. A file it
 * opens with the OS's default app (2.5).
 *
 * Moving to another directory keeps the current listing until the new one is read, so one that can't be
 * (no permission, gone) is reported and the pane stays where it was.
 *
 * Entries are selected (2.6) one at a time (`toggleSelection`), or as a group: `groupSelection` anchors a
 * range at the cursor (`range`), which then spans to wherever the cursor goes, on top of what's selected
 * already, until either command ends it and adds it to the selection (`selected`, by name, in listing
 * order). Another directory clears the selection; operations act on it, or on the entry under the cursor
 * when there is none (`targets`).
 * @extends {Handler<PaneState>}
 */
class Pane extends Handler {
  static kind = 'pane';

  /** @type {import('../../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'up', title: 'Cursor up' },
      { method: 'down', title: 'Cursor down' },
      { method: 'first', title: 'Cursor to the first entry' },
      { method: 'last', title: 'Cursor to the last entry' },
      { method: 'pageUp', title: 'Cursor up a page' },
      { method: 'pageDown', title: 'Cursor down a page' },
      { method: 'halfPageUp', title: 'Cursor up half a page' },
      { method: 'halfPageDown', title: 'Cursor down half a page' },
      { method: 'open', title: 'Open', description: "Enters the directory under the cursor, or opens the file with the OS's default app" },
      { method: 'enter', title: 'Enter the directory', description: 'Enters the directory under the cursor; does nothing on a file' },
      { method: 'toParent', title: 'Go to the parent directory' },
      { method: 'home', title: 'Go to the home directory' },
      { method: 'back', title: 'Go back', description: 'To the directory shown before, in this pane' },
      { method: 'forward', title: 'Go forward', description: 'To the directory left by going back' },
      { method: 'navigate', title: 'Go to a directory', description: 'Shows the directory at a path or URI' },
      { method: 'toggleSelection', title: 'Select or unselect', description: 'Selects or unselects the entry under the cursor and moves down; while selecting a group, ends it' },
      { method: 'groupSelection', title: 'Select a group', description: 'Selects from here to wherever the cursor goes, until pressed again' },
      { method: 'unselect', title: 'Unselect', description: 'Drops the group being selected, or else the whole selection' },
      { method: 'selectAll', title: 'Select all' },
      { method: 'invertSelection', title: 'Invert the selection' },
    ],
    keybindings: [
      { key: 'up', command: 'pane.up' },
      { key: 'k', command: 'pane.up' },
      { key: 'down', command: 'pane.down' },
      { key: 'j', command: 'pane.down' },
      { key: 'home', command: 'pane.first' },
      { key: 'g g', command: 'pane.first' },
      { key: 'end', command: 'pane.last' },
      { key: 'shift+g', command: 'pane.last' },
      { key: 'pageup', command: 'pane.pageUp' },
      { key: 'ctrl+b', command: 'pane.pageUp' },
      { key: 'pagedown', command: 'pane.pageDown' },
      { key: 'ctrl+f', command: 'pane.pageDown' },
      { key: 'ctrl+u', command: 'pane.halfPageUp' },
      { key: 'ctrl+d', command: 'pane.halfPageDown' },
      { key: 'enter', command: 'pane.open' },
      { key: 'l', command: 'pane.open' },
      { key: 'right', command: 'pane.open' },
      { key: 'h', command: 'pane.toParent' },
      { key: 'left', command: 'pane.toParent' },
      { key: 'backspace', command: 'pane.toParent' },
      { key: 'alt+up', command: 'pane.toParent' },
      { key: '~', command: 'pane.home' },
      { key: 'alt+left', command: 'pane.back' },
      { key: 'ctrl+o', command: 'pane.back' },
      { key: 'alt+right', command: 'pane.forward' },
      { key: 'v', command: 'pane.toggleSelection' },
      { key: 'shift+v', command: 'pane.groupSelection' },
      { key: 'escape', command: 'pane.unselect' },
      { key: 'ctrl+a', command: 'pane.selectAll' },
      { key: '*', command: 'pane.invertSelection' },
    ],
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
      { key: 'selected', default: { fg: 173, bg: 235, bold: true }, description: 'Selected entries (vifm: Selected).' },
    ],
  };

  /** @type {string} */
  #uri;
  /** Counts listings started, so one outdated by a newer one — or by disposal — stops touching state. */
  #generation = 0;
  /** @type {Promise<Outcome>} The latest listing. */
  #listing = Promise.resolve(/** @type {Outcome} */ ('listed'));
  /** @type {Promise<void>} The latest listing's details. */
  #details = Promise.resolve();
  /** @type {string[]} Directories shown, oldest first, as URIs. */
  #history = [];
  /** Where in `#history` the pane is. */
  #index = 0;
  /** @type {Map<string, string>} The entry the cursor was on when each directory was left, oldest first. */
  #positions = new Map();
  /** Rows the UI shows at once, which the page commands move by; the UI reports it (`setPageSize()`). */
  #pageSize = 20;

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
    this.#uri = canonical(uri);
  }

  onInit() {
    this.update({ uri: this.#uri, status: 'loading', entries: [], cursor: 0, selected: [], range: null });
    this.#history = [this.#uri];
    this.#index = 0;
    // Not awaited: vin starts while the directory is read.
    this.#list(this.#uri, null);
  }

  onDispose() {
    this.#generation++;
  }

  /**
   * Resolves once the latest directory asked for is listed and every entry's details are in, or listing it
   * failed.
   * @returns {Promise<void>}
   */
  get loaded() {
    return this.#listing.then(() => this.#details);
  }

  /**
   * Tells the pane how many rows the UI shows at once, for the page commands.
   * @param {number} rows
   * @throws {TypeError} If `rows` isn't a positive integer.
   */
  setPageSize(rows) {
    if (!Number.isInteger(rows) || rows < 1) {
      throw new TypeError(`Expected a positive number of rows, got ${JSON.stringify(rows)}`);
    }
    this.#pageSize = rows;
  }

  up() {
    this.#move(this.state.cursor - 1);
  }

  down() {
    this.#move(this.state.cursor + 1);
  }

  first() {
    this.#move(0);
  }

  last() {
    this.#move(this.state.entries.length - 1);
  }

  /**
   * Moves the cursor up a page less a row. As the view scrolls only as far as keeps the cursor in it, that
   * takes it to the top row shown, then pages so the top row becomes the bottom one.
   */
  pageUp() {
    this.#move(this.state.cursor - Math.max(1, this.#pageSize - 1));
  }

  /** Moves the cursor down a page less a row, as `pageUp()` goes up. */
  pageDown() {
    this.#move(this.state.cursor + Math.max(1, this.#pageSize - 1));
  }

  halfPageUp() {
    this.#move(this.state.cursor - Math.max(1, Math.floor(this.#pageSize / 2)));
  }

  halfPageDown() {
    this.#move(this.state.cursor + Math.max(1, Math.floor(this.#pageSize / 2)));
  }

  /**
   * Enters the directory under the cursor, or opens the file with the OS's default app (2.5). The command
   * is done once the app is asked for — not waiting for the launcher, whose failure is reported when it
   * comes.
   */
  async open() {
    const entry = this.state.entries[this.state.cursor];
    if (entry?.type === 'directory') {
      await this.enter();
      return;
    }
    if (!entry) {
      return;
    }
    const uri = childUri(this.state.uri, entry.name);
    if (entry.type !== 'file') {
      throw failure(entry.type === 'unknown'
        ? `Can't open ${entry.name}: the link's target is missing`
        : `Can't open ${entry.name}: only files open with an app`);
    }
    let path;
    try {
      path = paths.fromUri(uri);
    } catch {
      throw failure(`Can't open ${paths.displayUri(uri)}: only files on this computer open with an app, for now`);
    }
    opener.openWithDefaultApp(path).catch((error) => this.report(error));
  }

  /** Enters the directory under the cursor; on anything else, does nothing. */
  async enter() {
    const entry = this.state.entries[this.state.cursor];
    if (entry?.type === 'directory') {
      await this.#go(canonical(childUri(this.state.uri, entry.name)), null);
    }
  }

  /**
   * Goes up to the parent directory, with the cursor on the one it came from — from a drive's root on
   * Windows, to the list of drives (2.4). A root has none.
   */
  async toParent() {
    const up = parentUri(this.state.uri);
    if (up) {
      await this.#go(up.uri, up.name);
    }
  }

  /** Goes to the user's home directory. */
  async home() {
    await this.#go(paths.toUri(paths.home), null);
  }

  /** Goes back to the directory shown before this one. */
  async back() {
    await this.#step(-1);
  }

  /** Goes forward again, after going back. */
  async forward() {
    await this.#step(1);
  }

  /**
   * Shows another directory.
   * @param {string} target A URI (`sftp://host/x`), or a path as `paths.resolve()` reads it — typed or
   *   pasted, native or Unix-style, `~/…` — relative to the directory shown.
   * @throws {TypeError} If `target` isn't a string.
   * @throws {Error} With code `EPATH`, if it isn't a path.
   */
  async navigate(target) {
    if (typeof target !== 'string') {
      throw new TypeError(`Expected a path or URI, got ${JSON.stringify(target)}`);
    }
    // A scheme of two letters at least: `C:` starts a Windows path.
    const uri = /^[a-z][a-z\d+.-]+:/i.test(target) ? canonical(target) : paths.resolveUri(target, this.state.uri);
    await this.#go(uri, null);
  }

  /**
   * Selects or unselects the entry under the cursor, then moves down; while selecting a group, ends it
   * instead, adding it to the selection.
   */
  toggleSelection() {
    const { entries, cursor, range, selected } = this.state;
    if (range !== null) {
      this.#select(this.#selectedNames());
      return;
    }
    const name = entries[cursor]?.name;
    if (name === undefined) {
      return;
    }
    const names = new Set(selected);
    if (!names.delete(name)) {
      names.add(name);
    }
    this.#select(names);
    this.#move(cursor + 1);
  }

  /**
   * Starts selecting a group at the cursor — from there to wherever the cursor goes, on top of what's
   * selected already; or, while selecting one, ends it, adding it to the selection.
   */
  groupSelection() {
    const { entries, cursor, range } = this.state;
    if (range !== null) {
      this.#select(this.#selectedNames());
    } else if (entries.length) {
      this.state.range = cursor;
    }
  }

  /** Drops the group being selected; else, unselects everything. */
  unselect() {
    if (this.state.range !== null) {
      this.state.range = null;
    } else if (this.state.selected.length) {
      this.state.selected = [];
    }
  }

  selectAll() {
    this.#select(this.state.entries.map((entry) => entry.name));
  }

  /** Selects what isn't selected, and unselects what is — a group being selected included, which ends. */
  invertSelection() {
    const selected = this.#selectedNames();
    this.#select(this.state.entries.filter((entry) => !selected.has(entry.name)).map((entry) => entry.name));
  }

  /**
   * What an operation acts on (2.7): the entries selected — with the group being selected — or else the
   * one under the cursor.
   * @returns {string[]} Names, in listing order; none in an empty directory.
   */
  get targets() {
    const selected = this.#selectedNames();
    const { entries, cursor } = this.state;
    if (selected.size) {
      return entries.filter((entry) => selected.has(entry.name)).map((entry) => entry.name);
    }
    return entries[cursor] ? [entries[cursor].name] : [];
  }

  /**
   * @returns {Set<string>} The names selected, with the group being selected.
   */
  #selectedNames() {
    const { entries, cursor, range, selected } = this.state;
    const names = new Set(selected);
    if (range !== null) {
      for (let i = Math.min(range, cursor); i <= Math.max(range, cursor); i++) {
        names.add(entries[i].name);
      }
    }
    return names;
  }

  /**
   * Makes these names the selection, in listing order, ending any group being selected.
   * @param {Iterable<string>} names
   */
  #select(names) {
    const set = new Set(names);
    const selected = this.state.entries.filter((entry) => set.has(entry.name)).map((entry) => entry.name);
    Object.assign(this.state, { selected, range: null });
  }

  /**
   * Puts the cursor on an entry, kept within the listing.
   * @param {number} index
   */
  #move(index) {
    const count = this.state.entries.length;
    const cursor = Math.max(0, Math.min(index, count - 1));
    if (count && cursor !== this.state.cursor) {
      this.state.cursor = cursor;
    }
  }

  /**
   * Shows a directory and adds it to the history, dropping any ahead, as a browser does.
   * @param {string} uri Canonical.
   * @param {string | null} focus The entry to put the cursor on; else where it was left, or the first.
   */
  async #go(uri, focus) {
    if (await this.#list(uri, focus) !== 'listed' || this.#history[this.#index] === uri) {
      return;
    }
    this.#history.splice(this.#index + 1, Infinity, uri);
    if (this.#history.length > HISTORY_SIZE) {
      this.#history.shift();
    }
    this.#index = this.#history.length - 1;
  }

  /**
   * Moves through the history. A directory there that can't be listed any more is dropped from it.
   * @param {-1 | 1} delta
   */
  async #step(delta) {
    const index = this.#index + delta;
    const uri = this.#history[index];
    if (uri === undefined) {
      return;
    }
    const outcome = await this.#list(uri, null);
    if (outcome === 'listed') {
      this.#index = index;
    } else if (outcome === 'failed') {
      this.#history.splice(index, 1);
      this.#index -= Number(index < this.#index);
    }
  }

  /**
   * Starts listing a directory, as the latest listing.
   * @param {string} uri
   * @param {string | null} focus
   * @returns {Promise<Outcome>} Once it's shown, or not.
   */
  #list(uri, focus) {
    this.#listing = this.#load(uri, focus);
    return this.#listing;
  }

  /**
   * Lists a directory and shows it, then fetches its entries' details in batches from the top (`#details`).
   * A failure to list is reported.
   * @param {string} uri
   * @param {string | null} focus
   * @returns {Promise<Outcome>} Once the listing is shown, or not.
   */
  async #load(uri, focus) {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    /** @type {import('../../../fs/file-system').DirectoryEntry[]} */
    let listed;
    try {
      listed = await this.fs.readDirectory(uri);
    } catch (error) {
      if (!current()) {
        return 'superseded';
      }
      if (this.state.status === 'loading') {
        this.state.status = 'failed';
      }
      this.report(error);
      return 'failed';
    }
    if (!current()) {
      return 'superseded';
    }
    const entries = listed
      .map(({ name, type, symlink }) => ({ name, type, symlink, executable: false, size: null, mtime: null }))
      .sort(compareEntries);
    this.#remember();
    const name = focus ?? this.#positions.get(uri) ?? null;
    const cursor = name === null ? 0 : Math.max(0, entries.findIndex((entry) => entry.name === name));
    // The same directory again keeps what's still there selected.
    const kept = new Set(uri === this.state.uri ? this.state.selected : []);
    const selected = entries.filter((entry) => kept.has(entry.name)).map((entry) => entry.name);
    Object.assign(this.state, { uri, status: 'ready', entries, cursor, selected, range: null });
    this.#details = this.#fetchDetails(uri, entries, current);
    return 'listed';
  }

  /**
   * Remembers the entry under the cursor in the directory shown, for when the pane comes back to it.
   */
  #remember() {
    const { uri, status, entries, cursor } = this.state;
    if (status !== 'ready' || !entries[cursor]) {
      return;
    }
    this.#positions.delete(uri);
    this.#positions.set(uri, entries[cursor].name);
    if (this.#positions.size > POSITIONS_SIZE) {
      this.#positions.delete(/** @type {string} */ (this.#positions.keys().next().value));
    }
  }

  /**
   * Fetches the entries' details in batches, each batch one update — or, while one is slow to answer (a
   * disconnected network drive takes seconds), one update of what has come every `SLOW_STAT` ms, so it
   * doesn't hold up the rest. An entry that can't be read (gone since, or no permission) keeps none.
   * @param {string} uri The directory listed.
   * @param {Entry[]} entries As listed, in the order shown.
   * @param {() => boolean} current Whether this listing is still the latest.
   */
  async #fetchDetails(uri, entries, current) {
    for (let start = 0; start < entries.length; start += STAT_BATCH) {
      /** @type {Map<number, import('../../../fs/file-system').FileStat>} */
      const arrived = new Map();
      let done = false;
      const batch = Promise.all(entries.slice(start, start + STAT_BATCH).map((entry, i) => this.fs.stat(childUri(uri, entry.name))
        .then((stat) => {
          arrived.set(start + i, stat);
        }, () => {})))
        .then(() => {
          done = true;
        });
      while (!done) {
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let timer;
        await Promise.race([batch, new Promise((resolve) => {
          timer = setTimeout(resolve, SLOW_STAT);
        })]);
        clearTimeout(timer);
        if (!current()) {
          return;
        }
        for (const [index, { size, mtime, executable, free }] of arrived) {
          Object.assign(this.state.entries[index], { size, mtime, executable }, free === undefined ? {} : { free });
        }
        arrived.clear();
      }
    }
  }
}

module.exports = Pane;
