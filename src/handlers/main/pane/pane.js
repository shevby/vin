const Handler = require('../../../handler');
const { childUri, parentUri } = require('../../../fs/file-system');
const { paths } = require('../../../paths');
const { failure } = require('../../../errors');
const { opener } = require('../../../open');
const ChoiceList = require('../../choice-list/choice-list');
const Confirm = require('../../confirm/confirm');
const Prompt = require('../../prompt/prompt');
const { transfer, within, same, statOrNull } = require('./operations');
const { checkPattern, expand, extension } = require('./pattern');

/**
 * @typedef {import('../../../fs/file-system').FileType} FileType
 * @typedef {import('./operations').Mode} Mode
 * @typedef {import('./operations').Conflict} Conflict
 * @typedef {import('./operations').Resolution} Resolution
 */

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

/** How each operation is named, in a conflict's title and in the message after it. */
const VERBS = /** @type {const} */ ({
  copy: { doing: 'Copying', done: 'Copied' },
  move: { doing: 'Moving', done: 'Moved' },
  link: { doing: 'Linking', done: 'Linked' },
});

/**
 * Names in a message: the one name, or how many.
 * @param {string[]} names
 * @returns {string}
 */
function describe(names) {
  return names.length === 1 ? names[0] : `${names.length} items`;
}

/**
 * What's wrong with a name for a new or renamed entry, if anything: none of the path's separators, and
 * not `.` or `..`. Characters the file system refuses (`:` on Windows) are its to report.
 * @param {string} name
 * @returns {string | null}
 */
function checkName(name) {
  if (!name) {
    return "A name can't be empty";
  }
  if (name.includes('/') || (process.platform === 'win32' && name.includes('\\'))) {
    return `A name can't hold ${process.platform === 'win32' ? '/ or \\' : '/'}`;
  }
  return name === '.' || name === '..' ? `${name} isn't a name` : null;
}

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
 *
 * File operations (2.7): entries are copied or cut to vin's clipboard (`this.clipboard`, `src/clipboard.js`)
 * and pasted — as copies, moved, or as symlinks — into any pane's directory, or copied or moved straight to
 * a directory (the other pane's, through `main`); a name already there is asked about (`operations.js`).
 * Deleting moves entries to the trash, a directory set in `pane.trash`, or else deletes them for good —
 * after asking, unless `pane.confirmDelete` is off. Entries are renamed and created in a prompt — several
 * renamed with one name, a pattern (2.8, `pattern.js`). A pane reloads after its own operations, and emits
 * `changed` with the directories they changed, which `main` reloads the other pane for; watching for
 * changes made elsewhere is 2.15.
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
      { method: 'copy', title: 'Copy', description: 'Puts the entries selected, or the one under the cursor, on the clipboard, to paste copies of' },
      { method: 'cut', title: 'Cut', description: 'Puts the entries on the clipboard, to move where they are pasted' },
      { method: 'paste', title: 'Paste', description: 'Copies or moves the entries on the clipboard here' },
      { method: 'pasteLinks', title: 'Paste as symlinks', description: 'Creates symlinks here to the entries on the clipboard' },
      { method: 'copyTo', title: 'Copy to a directory', description: 'Copies the entries to a path or URI' },
      { method: 'moveTo', title: 'Move to a directory', description: 'Moves the entries to a path or URI' },
      { method: 'delete', title: 'Delete', description: 'Moves the entries to the trash, if pane.trash is set; else, or with true, deletes them for good' },
      { method: 'rename', title: 'Rename', description: 'Renames the entry under the cursor, or the ones selected with one name: $n counts from 1, $i from 0, $e is the extension' },
      { method: 'create', title: 'Create a file or directory', description: 'A name ending with / is a directory; one with / inside creates the directories on the way' },
      { method: 'reload', title: 'Reload', description: 'Lists the directory again' },
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
      { key: 'y y', command: 'pane.copy' },
      { key: 'ctrl+c', command: 'pane.copy' },
      { key: 'cmd+c', command: 'pane.copy' },
      { key: 'd d', command: 'pane.cut' },
      { key: 'ctrl+x', command: 'pane.cut' },
      { key: 'cmd+x', command: 'pane.cut' },
      { key: 'p', command: 'pane.paste' },
      { key: 'ctrl+v', command: 'pane.paste' },
      { key: 'cmd+v', command: 'pane.paste' },
      { key: 'shift+p', command: 'pane.pasteLinks' },
      { key: 'shift+d shift+d', command: 'pane.delete' },
      { key: 'delete', command: 'pane.delete' },
      { key: 'shift+delete', command: 'pane.delete', args: [true] },
      { key: 'c w', command: 'pane.rename' },
      { key: 'c a w', command: 'pane.rename' },
      { key: 'c i w', command: 'pane.rename' },
      { key: 'c c', command: 'pane.rename' },
      { key: 'a', command: 'pane.create' },
    ],
    configuration: [
      {
        key: 'trash',
        type: 'string',
        default: '',
        description: "A directory deleting moves entries to, e.g. '~/.trash' (created when first needed); empty: deleting is permanent. shift+Delete always deletes for good, as does deleting inside the trash.",
      },
      {
        key: 'confirmDelete',
        type: 'boolean',
        default: true,
        description: 'Ask before deleting for good.',
      },
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
    await this.#go(this.#resolve(target), null);
  }

  /**
   * @param {unknown} target A URI, or a path relative to the directory shown.
   * @returns {string} Its URI, canonical.
   * @throws {TypeError} If `target` isn't a string.
   * @throws {Error} With code `EPATH`, if it isn't a path.
   */
  #resolve(target) {
    if (typeof target !== 'string') {
      throw new TypeError(`Expected a path or URI, got ${JSON.stringify(target)}`);
    }
    // A scheme of two letters at least: `C:` starts a Windows path.
    return /^[a-z][a-z\d+.-]+:/i.test(target) ? canonical(target) : paths.resolveUri(target, this.state.uri);
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

  /** Puts the targets on the clipboard, to paste copies of, and ends the selection. */
  copy() {
    this.#yank('copy');
  }

  /** Puts the targets on the clipboard, to move where they're pasted, and ends the selection. */
  cut() {
    this.#yank('cut');
  }

  /**
   * Pastes the clipboard here: copies, or moves what was cut — which then leaves the clipboard.
   */
  async paste() {
    const content = this.clipboard.content;
    if (!content) {
      this.notify('Nothing to paste: copy or cut something first', 'warning');
      return;
    }
    await this.#paste(content);
  }

  /** Creates symlinks here to the entries on the clipboard, cut ones too, which stay on it. */
  async pasteLinks() {
    const content = this.clipboard.content;
    if (!content) {
      this.notify('Nothing to link to: copy or cut something first', 'warning');
      return;
    }
    await this.#transfer('link', content.uris, this.state.uri);
  }

  /**
   * Copies the targets to a directory, and ends the selection.
   * @param {string} destination A URI, or a path relative to the directory shown.
   */
  async copyTo(destination) {
    await this.#send('copy', this.#resolve(destination));
  }

  /**
   * Moves the targets to a directory.
   * @param {string} destination A URI, or a path relative to the directory shown.
   */
  async moveTo(destination) {
    await this.#send('move', this.#resolve(destination));
  }

  /**
   * Deletes the targets: moves them to the trash (`pane.trash`), if there is one and they aren't in it —
   * keeping both of two with one name there — or else deletes them for good, after asking
   * (`pane.confirmDelete`).
   * @param {boolean} [permanent] Delete for good even with a trash. Default: false.
   */
  async delete(permanent = false) {
    const names = this.targets;
    if (!names.length) {
      return;
    }
    const here = this.#files();
    const uris = names.map((name) => childUri(here, name));
    const trash = permanent === true ? null : this.#trash();
    if (trash && !within(here, trash)) {
      await this.fs.createDirectory(trash, { recursive: true });
      const outcome = await transfer(this.fs, { mode: 'move', sources: uris, destination: trash, resolve: async () => ({ action: 'keepBoth', all: true }) });
      outcome.failures.forEach((error) => this.report(error));
      await this.#changed([here, trash], null);
      if (outcome.created.length) {
        this.notify(`Moved ${describe(names.length === outcome.created.length ? names : outcome.created)} to the trash`);
      }
      return;
    }
    if (this.config.get('pane.confirmDelete')) {
      const confirmed = await this.openWindow(new Confirm({
        title: 'Delete',
        message: `Delete ${describe(names)} for good?`,
        yes: 'Delete',
        no: 'Cancel',
      }));
      if (confirmed !== true) {
        return;
      }
    }
    /** @type {string[]} */
    const deleted = [];
    for (const [i, uri] of uris.entries()) {
      try {
        await this.fs.delete(uri, { recursive: true });
        deleted.push(names[i]);
      } catch (error) {
        this.report(error);
      }
    }
    await this.#changed([here], null);
    if (deleted.length) {
      this.notify(`Deleted ${describe(deleted)}`);
    }
  }

  /**
   * Renames the targets: one in a prompt that starts with its name, the cursor before its extension; two
   * or more with one name, a pattern (`renameAll`).
   */
  async rename() {
    const names = this.targets;
    if (names.length > 1) {
      await this.#renameAll(names);
      return;
    }
    const entry = this.state.entries.find((candidate) => candidate.name === names[0]);
    if (!entry) {
      return;
    }
    const here = this.#files();
    const { name } = entry;
    const dot = name.lastIndexOf('.');
    const renamed = await this.openWindow(new Prompt({
      title: 'Rename',
      message: name,
      value: name,
      cursor: entry.type !== 'directory' && dot > 0 ? dot : name.length,
      validate: async (text) => {
        if (text === name) {
          return null;
        }
        const problem = checkName(text);
        if (problem) {
          return problem;
        }
        // Another case of its own name is a rename, where the file system ignores case.
        const taken = await statOrNull(this.fs, childUri(here, text));
        return taken && !same(childUri(here, text), childUri(here, name)) ? `${text} already exists` : null;
      },
    }));
    if (typeof renamed !== 'string' || renamed === name) {
      return;
    }
    await this.fs.rename(childUri(here, name), childUri(here, renamed));
    await this.#changed([here], renamed);
  }

  /**
   * Renames several entries with one name, a pattern (`pattern.js`: `$n`, `$i`, `$e`), in listing order;
   * the prompt previews the names it gives and refuses one taken by an entry not being renamed. It starts
   * with the extension they share, or else `$e`. Names are swapped among them through temporary ones.
   * @param {string[]} names At least two, in listing order.
   */
  async #renameAll(names) {
    const here = this.#files();
    const types = new Map(this.state.entries.map((entry) => [entry.name, entry.type]));
    const entries = names.map((name) => ({ name, directory: types.get(name) === 'directory' }));
    const count = entries.length;
    const extensions = new Set(entries.map((entry) => extension(entry.name, entry.directory)));
    /** @param {string} pattern */
    const namesFor = (pattern) => entries.map((entry, index) => expand(pattern, { index, count, ...entry }));
    /** @param {string} name */
    const key = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);
    const renamed = new Set(names.map(key));
    const pattern = await this.openWindow(new Prompt({
      title: `Rename ${count} items`,
      message: "One name for all: $n counts from 1, $i from 0, $e is each one's extension",
      value: extensions.size === 1 ? [...extensions][0] : '$e',
      cursor: 0,
      preview: (text) => {
        if (checkPattern(text, count)) {
          return null;
        }
        const lines = namesFor(text).map((to, i) => `${names[i]} → ${to}`);
        return (lines.length > 4 ? [lines[0], lines[1], '…', lines.at(-1)] : lines).join('\n');
      },
      validate: async (text) => {
        const targets = namesFor(text);
        const problem = checkPattern(text, count) ?? targets.map(checkName).find(Boolean);
        if (problem) {
          return problem;
        }
        if (new Set(targets.map(key)).size < count) {
          return 'Two would get the same name';
        }
        const taken = await Promise.all(targets.map((name) => (renamed.has(key(name)) ? null : statOrNull(this.fs, childUri(here, name)))));
        const first = taken.findIndex(Boolean);
        return first < 0 ? null : `${targets[first]} already exists`;
      },
    }));
    if (typeof pattern !== 'string') {
      return;
    }
    const targets = namesFor(pattern);
    const moves = names.map((from, i) => ({ from, to: targets[i] })).filter(({ from, to }) => from !== to);
    // A name another of them has now: all go through temporary names first.
    const sources = new Set(moves.map(({ from }) => key(from)));
    const swapped = moves.some(({ from, to }) => key(to) !== key(from) && sources.has(key(to)));
    const current = moves.map(({ from }) => from);
    /** @type {string[][]} */
    const steps = swapped ? [moves.map((_, i) => `.vin-rename-${process.pid}-${Date.now()}-${i}`)] : [];
    steps.push(moves.map(({ to }) => to));
    let done = 0;
    for (const [step, next] of steps.entries()) {
      for (const [i, name] of next.entries()) {
        try {
          await this.fs.rename(childUri(here, current[i]), childUri(here, name));
          current[i] = name;
          done += Number(step === steps.length - 1);
        } catch (error) {
          this.report(error);
        }
      }
    }
    this.#select([]);
    await this.#changed([here], targets[0]);
    this.notify(`Renamed ${done} of ${count} items`);
  }

  /**
   * Creates a file, or a directory if the name typed ends with `/` — with the directories on the way, for
   * a name with `/` inside (`src/lib/`).
   */
  async create() {
    const here = this.#files();
    const separator = process.platform === 'win32' ? /[\\/]/ : /\//;
    /** @param {string} text */
    const parts = (text) => text.split(separator);
    const typed = await this.openWindow(new Prompt({
      title: 'Create',
      message: 'A file, or a directory: end it with /',
      validate: async (text) => {
        const names = parts(text);
        if (names.at(-1) === '') {
          names.pop();
        }
        const problem = names.length ? names.map(checkName).find(Boolean) : "A name can't be empty";
        if (problem) {
          return problem;
        }
        const uri = names.reduce(childUri, here);
        return await statOrNull(this.fs, uri) ? `${names.join('/')} already exists` : null;
      },
    }));
    if (typeof typed !== 'string') {
      return;
    }
    const names = parts(typed);
    const directory = names.at(-1) === '';
    if (directory) {
      names.pop();
    }
    const parent = names.slice(0, -1).reduce(childUri, here);
    if (names.length > 1) {
      await this.fs.createDirectory(parent, { recursive: true });
    }
    const uri = childUri(parent, /** @type {string} */ (names.at(-1)));
    if (directory) {
      await this.fs.createDirectory(uri);
    } else {
      await this.fs.writeFile(uri, '');
    }
    await this.#changed([here], names[0]);
  }

  /** Lists the directory again, keeping the cursor on its entry, and what's still there selected. */
  async reload() {
    await this.#list(this.state.uri, null);
  }

  /**
   * Takes a paste of paths — vin's own from the clipboard, as a terminal whose `ctrl+v` pastes text sends
   * them (Windows Terminal), or any others — as a paste of those entries. A single character is a key.
   * @param {string} text
   * @returns {boolean}
   */
  onText(text) {
    if ([...text].length < 2) {
      return false;
    }
    const content = this.clipboard.recognize(text);
    if (!content) {
      this.notify("Only paths can be pasted here, one per line", 'warning');
      return true;
    }
    this.#paste(content).catch((error) => this.report(error));
    return true;
  }

  /**
   * @param {'copy' | 'cut'} mode
   */
  #yank(mode) {
    const names = this.targets;
    if (!names.length) {
      return;
    }
    const here = this.#files();
    this.clipboard.set(mode, names.map((name) => childUri(here, name)));
    this.#select([]);
    this.notify(`${mode === 'copy' ? 'Copied' : 'Cut'} ${describe(names)} — paste to ${mode === 'copy' ? 'copy' : 'move'} ${names.length === 1 ? 'it' : 'them'}`);
  }

  /**
   * Pastes clipboard content here.
   * @param {import('../../../clipboard').ClipboardContent} content
   */
  async #paste({ mode, uris }) {
    const outcome = await this.#transfer(mode === 'cut' ? 'move' : 'copy', uris, this.state.uri);
    if (mode === 'cut' && !outcome.cancelled) {
      this.clipboard.clear();
    }
  }

  /**
   * Copies or moves the targets to a directory, and ends the selection.
   * @param {'copy' | 'move'} mode
   * @param {string} destination A URI.
   */
  async #send(mode, destination) {
    const names = this.targets;
    if (!names.length) {
      return;
    }
    const here = this.#files();
    this.#select([]);
    await this.#transfer(mode, names.map((name) => childUri(here, name)), destination);
  }

  /**
   * Copies, moves or links entries into a directory, asking about names already there; reports what
   * failed and says what was done.
   * @param {Mode} mode
   * @param {string[]} uris
   * @param {string} destination
   * @returns {Promise<import('./operations').Outcome>}
   */
  async #transfer(mode, uris, destination) {
    this.#files(destination);
    const outcome = await transfer(this.fs, { mode, sources: uris, destination, resolve: (conflict) => this.#ask(mode, conflict) });
    outcome.failures.forEach((error) => this.report(error));
    const sources = mode === 'move' ? uris.map((uri) => parentUri(uri)?.uri).filter((uri) => uri !== undefined) : [];
    const here = same(destination, this.state.uri);
    await this.#changed([destination, ...sources], here ? outcome.created[0] ?? null : null);
    const parts = [];
    if (outcome.created.length) {
      parts.push(`${VERBS[mode].done} ${describe(outcome.created)}${here ? '' : ` to ${paths.displayUri(destination)}`}`);
    }
    if (outcome.skipped) {
      parts.push(`skipped ${outcome.skipped}`);
    }
    if (outcome.cancelled) {
      parts.push('cancelled the rest');
    }
    if (parts.length) {
      const text = parts.join(', ');
      this.notify(text[0].toUpperCase() + text.slice(1));
    }
    return outcome;
  }

  /**
   * Asks what to do about a name taken at the destination.
   * @param {Mode} mode
   * @param {Conflict} conflict
   * @returns {Promise<Resolution>}
   */
  async #ask(mode, { name, directory, merge }) {
    const replace = merge ? 'Merge' : 'Overwrite';
    const key = merge ? 'm' : 'o';
    const choices = [
      { label: replace, key, value: 'overwrite', description: merge ? 'Put its entries in, asking about each one there' : undefined },
      { label: `${replace} all`, key: key.toUpperCase(), value: 'overwrite all', description: 'Overwrite files and merge directories from now on' },
      { label: 'Skip', key: 's', value: 'skip' },
      { label: 'Skip all', key: 'S', value: 'skip all' },
      { label: 'Keep both', key: 'b', value: 'keepBoth', description: 'Give the new one a free name: name (2)' },
      { label: 'Keep both for all', key: 'B', value: 'keepBoth all' },
      { label: 'Cancel', key: 'c', value: 'cancel', description: 'Stop here' },
    ];
    const answer = await this.openWindow(new ChoiceList({
      title: VERBS[mode].doing,
      message: `${name} is already in ${paths.displayUri(directory)}`,
      choices,
      // Enter on the safe answer.
      selected: 2,
    }));
    if (typeof answer !== 'string') {
      return { action: 'cancel' };
    }
    const [action, all] = answer.split(' ');
    return { action: /** @type {import('./operations').Action} */ (action), all: all === 'all' };
  }

  /**
   * After an operation: reloads the pane if it changed its directory, and tells `main` which it changed.
   * @param {string[]} uris Directories changed.
   * @param {string | null} focus The entry to put the cursor on, if it's in the pane's directory.
   */
  async #changed(uris, focus) {
    this.emit('changed', { uris: [...new Set(uris)] });
    if (uris.some((uri) => same(uri, this.state.uri))) {
      await this.#list(this.state.uri, focus);
    }
  }

  /**
   * The trash directory, if `pane.trash` sets one.
   * @returns {string | null} Its URI.
   * @throws {Error} A failure, if it isn't an absolute path.
   */
  #trash() {
    const trash = /** @type {string} */ (this.config.get('pane.trash'));
    if (!trash) {
      return null;
    }
    try {
      return paths.toUri(paths.resolve(trash));
    } catch (error) {
      throw failure(`pane.trash in the config must be an absolute path: ${/** @type {Error} */ (error).message}`);
    }
  }

  /**
   * @param {string} [uri] A directory. Default: the one shown.
   * @returns {string} It, if it can hold files.
   * @throws {Error} A failure for the list of drives (2.4), which holds none.
   */
  #files(uri = this.state.uri) {
    if (uri === paths.drives) {
      throw failure('The list of drives holds no files; go into a drive first');
    }
    return uri;
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
    const found = name === null ? -1 : entries.findIndex((entry) => entry.name === name);
    // An entry gone from the same directory — deleted, moved — leaves the cursor on its row.
    const cursor = Math.max(0, found >= 0 ? found : uri === this.state.uri ? Math.min(this.state.cursor, entries.length - 1) : 0);
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
