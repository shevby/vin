const Handler = require('../../../handler');
const { childUri, parentUri } = require('../../../fs/file-system');
const { paths } = require('../../../paths');
const { failure } = require('../../../errors');
const { opener } = require('../../../open');
const ChoiceList = require('../../choice-list/choice-list');
const Confirm = require('../../confirm/confirm');
const Prompt = require('../../prompt/prompt');
const { transfer, same, statOrNull } = require('./operations');
const { TRASH_URI } = require('../../../trash');
const { checkPattern, expand, extension } = require('./pattern');
const { SORT_KEYS, comparator, isHidden, describeSort } = require('./sorting');
const { matcher, splitPath, walk } = require('./search');
const SearchBar = require('./search-bar/search-bar');

/**
 * @typedef {import('../../../fs/file-system').FileType} FileType
 * @typedef {import('./operations').Mode} Mode
 * @typedef {import('./operations').Conflict} Conflict
 * @typedef {import('./operations').Resolution} Resolution
 * @typedef {import('./sorting').Sort} Sort
 * @typedef {import('./sorting').SortKey} SortKey
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
 * @property {boolean} hidden A name starting with `.`, or the Hidden attribute on Windows (2.11).
 * @property {number} [free] For a root — a drive in the list of drives (2.4) — the bytes free on it, once
 *   known.
 */

/**
 * `loading` until the first directory is read; `failed` if it couldn't be (the error is reported).
 * @typedef {'loading' | 'ready' | 'failed'} Status
 */

/**
 * What a search looks for (2.12): a query — wildcards, or `/a regex/` (`search.js`) — in the directory
 * shown, or in it and every directory below.
 * @typedef {object} Query
 * @property {string} query
 * @property {boolean} recursive
 */

/**
 * A search the pane shows: instead of the directory, only the entries matching — for a tree, named by their
 * path from the directory (`src/lib/x.js`).
 * @typedef {object} SearchState
 * @property {string} query
 * @property {boolean} recursive
 * @property {boolean} typing While the query is typed, in the search bar (`searchBar`).
 * @property {boolean} running While the tree is walked.
 * @property {number} scanned Entries of the tree walked so far.
 * @property {string | null} error Why the query isn't one — a bad regular expression — while it isn't.
 * @property {boolean} capped Whether matches are left out: past `MAX_MATCHES`, or past `MAX_WALK` entries.
 */

/**
 * A step of a pane's history: a directory, or a search in it, with the entry the cursor was on when the
 * pane left a search (a directory's is in `#positions`).
 * @typedef {object} Place
 * @property {string} uri
 * @property {Query | null} search
 * @property {string | null} cursor
 */

/**
 * The tree a search walks, kept while the pane shows the same directory, for the next search in it.
 * @typedef {object} Tree
 * @property {number} id Which walk fills it (`#walkId`).
 * @property {string} root
 * @property {boolean} showHidden Whether hidden entries were walked.
 * @property {Entry[]} entries Named by their path from the root.
 * @property {Map<string, Entry>} index By name.
 * @property {WeakSet<Entry>} statted Those whose details were asked for.
 * @property {boolean} done
 * @property {boolean} stopped Whether the walk stopped before it was done.
 * @property {boolean} capped Whether it stopped at `MAX_WALK` entries.
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
 * @property {boolean} showHidden Whether hidden entries are listed (2.11).
 * @property {number} hiddenCount How many hidden entries aren't, while they aren't.
 * @property {Sort} sort The listing's order.
 * @property {SearchState | null} search While the pane shows a search instead of the directory.
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

/** Matches a search lists at most — more would make each update of the list slow to send. */
const MAX_MATCHES = 10_000;

/** Entries a tree search keeps at most, walking; it stops there. */
const MAX_WALK = 500_000;

/** How often, in ms, a tree search shows what it has found, while it walks. */
const WALK_UPDATE = 250;

/**
 * @param {Query | null} a
 * @param {Query | null} b
 * @returns {boolean} Whether both are the same search, or both none.
 */
function sameQuery(a, b) {
  return a === null || b === null ? a === b : a.query === b.query && a.recursive === b.recursive;
}

/**
 * Whether an entry found in a tree is hidden by the file system's mark on it or on a directory it's in.
 * @param {string} path From the root, `/`-separated.
 * @param {Set<string>} hidden Paths so marked.
 * @returns {boolean}
 */
function markedHidden(path, hidden) {
  for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
    if (hidden.has(path.slice(0, slash))) {
      return true;
    }
  }
  return hidden.has(path);
}

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

/**
 * The top of the local file system, where the trash shows as `trash` (2.9): the list of drives on Windows,
 * `/` elsewhere.
 * @returns {string}
 */
function rootUri() {
  return paths.drives ?? 'file:///';
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
 * Deleting moves entries to the trash (`this.trash`, `src/trash.js`), if `pane.trash` is on, or else deletes
 * them for good — after asking, unless `pane.confirmDelete` is off. The trash shows as `/trash`: an entry
 * `trash` at the top (the list of drives on Windows, `/` elsewhere; a real `/trash` is hidden by it), and
 * a path to type; it's the `trash:` scheme, where `restore` puts entries back where they came from. Entries are renamed and created in a prompt — several
 * renamed with one name, a pattern (2.8, `pattern.js`). A pane reloads after its own operations, and emits
 * `changed` with the directories they changed, which `main` reloads the other pane for; watching for
 * changes made elsewhere is 2.15.
 *
 * Hidden entries (2.11) — a name starting with `.`, or the Hidden attribute on Windows — are listed, in
 * `pane.hidden`'s faded color, unless `pane.showHidden` is off or they're hidden with `hideHiddenEntries`.
 * The listing is sorted (`sorting.js`) by name, extension, size or modified time, either way, directories
 * first or not — from the config, changed per pane with `sort` and the sort menu (`chooseSort`). Sizes and
 * times come after the listing, so sorting by them orders it again once they're all in, keeping the cursor
 * on its entry.
 *
 * A search (2.12) lists only the entries matching a query (`search.js`) — of the directory (`search`), or of
 * it and every directory below (`searchTree`), walked in the background — as it's typed in the search bar
 * (`searchBar`); `enter` keeps the list, a step of the history, and `escape` goes back. Opening an entry
 * there goes to its directory, the cursor on it, and going back returns to the list, searched again.
 * Operations act on the entries listed, wherever they are, but paste and create need a directory, not a
 * list.
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
      { method: 'restore', title: 'Restore from the trash', description: 'Puts entries in /trash back where they were deleted from' },
      { method: 'emptyTrash', title: 'Empty the trash', description: 'Deletes everything in /trash for good' },
      { method: 'toggleHidden', title: 'Show or hide hidden entries', description: 'Names starting with ., and on Windows ones with the Hidden attribute' },
      { method: 'showHiddenEntries', title: 'Show hidden entries' },
      { method: 'hideHiddenEntries', title: 'Hide hidden entries' },
      { method: 'sort', title: 'Sort', description: 'By name, extension, size or modified; true reverses it' },
      { method: 'reverseSort', title: 'Reverse the order' },
      { method: 'toggleDirectoriesFirst', title: 'Directories first, or not' },
      { method: 'chooseSort', title: 'Choose the order', description: 'A menu: n name, e extension, s size, m modified — capitals the other way round' },
      { method: 'search', title: 'Search here', description: 'Lists only the entries matching what is typed: wildcards (* any characters, ? one), or /a regex/' },
      { method: 'searchTree', title: 'Search here and below', description: 'The same, in this directory and every one under it' },
      { method: 'nextMatch', title: 'Next match', description: "In a search's list, the next entry, from the last one round to the first" },
      { method: 'previousMatch', title: 'Previous match', description: "In a search's list, the previous entry, from the first one round to the last" },
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
      { key: 'r', command: 'pane.restore' },
      { key: 'z a', command: 'pane.toggleHidden' },
      { key: 'z o', command: 'pane.showHiddenEntries' },
      { key: 'z m', command: 'pane.hideHiddenEntries' },
      { key: 'o', command: 'pane.chooseSort' },
      { key: 'f', command: 'pane.search' },
      { key: '/', command: 'pane.search' },
      { key: 'shift+f', command: 'pane.searchTree' },
      { key: '?', command: 'pane.searchTree' },
      { key: 'n', command: 'pane.nextMatch' },
      { key: 'shift+n', command: 'pane.previousMatch' },
    ],
    configuration: [
      {
        key: 'trash',
        type: 'boolean',
        default: false,
        description: 'Deleting moves entries to the trash, shown as /trash, where r restores them; off, deleting is for good. shift+Delete always deletes for good, as does deleting in the trash.',
      },
      {
        key: 'trashDirectory',
        type: 'string',
        default: '',
        description: "Where the trash keeps entries; empty: .vin/trash in vin's folder. A relative path is relative to vin's folder. Where each came from is kept in .vin/trash.json.",
      },
      {
        key: 'confirmDelete',
        type: 'boolean',
        default: true,
        description: 'Ask before deleting for good.',
      },
      {
        key: 'showHidden',
        type: 'boolean',
        default: true,
        description: 'List hidden entries — names starting with ., and on Windows ones with the Hidden attribute — in a faded color (colors.pane.hidden). z a switches while vin runs.',
      },
      {
        key: 'sortBy',
        type: 'string',
        enum: [...SORT_KEYS],
        default: 'name',
        description: 'What the listing is sorted by: name (natural order: file2 before file10), extension, size, or modified. o changes it per pane.',
      },
      {
        key: 'sortReverse',
        type: 'boolean',
        default: false,
        description: 'Sort the other way round: Z to A, largest or newest first.',
      },
      {
        key: 'directoriesFirst',
        type: 'boolean',
        default: true,
        description: 'List directories before everything else.',
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
      { key: 'hidden', default: { dim: true }, description: "Hidden entries, over their type's color: faded, where the terminal can." },
      { key: 'sort', default: { fg: 244 }, description: "The order, in the bottom border, when it isn't by name (vifm: LineNr)." },
      { key: 'search', default: { fg: 71, bg: 235, bold: true }, description: 'The search and how many it found, in the bottom border (vifm: WildMenu).' },
      { key: 'location', default: { fg: 244 }, description: "Where an entry a tree search found is, in its second column (vifm: LineNr)." },
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
  /** @type {Entry[]} Every entry of the directory shown, hidden ones too, with their details as they come. */
  #all = [];
  /** @type {Place[]} Directories and searches shown, oldest first. */
  #history = [];
  /** Where in `#history` the pane is. */
  #index = 0;
  /** @type {Map<string, string>} The entry the cursor was on when each directory was left, oldest first. */
  #positions = new Map();
  /** Rows the UI shows at once, which the page commands move by; the UI reports it (`setPageSize()`). */
  #pageSize = 20;
  /** Whether a search is typed — the search bar has the focus. */
  #typing = false;
  /** @type {{ search: Query | null, cursor: string | null } | null} What the pane showed before the search typed. */
  #before = null;
  /** @type {Tree | null} */
  #tree = null;
  /** Counts tree walks started, so one replaced stops. */
  #walkId = 0;
  /** @type {string | null} The entry to put the cursor on once a search finds it, unless the cursor moves first. */
  #want = null;
  /** Whether details of a tree search's matches are being fetched. */
  #filling = false;

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
    /** Where searches are typed (2.12). @readonly */
    this.searchBar = this.add(new SearchBar('searchBar', {
      onChange: (query) => {
        if (this.#typing && this.state.search) {
          this.state.search.query = query;
          this.#applyQuery();
        }
      },
      onAccept: () => this.#accept(),
      onCancel: () => this.#cancel(),
    }));
  }

  onInit() {
    const config = this.config;
    this.update({
      uri: this.#uri,
      status: 'loading',
      entries: [],
      cursor: 0,
      selected: [],
      range: null,
      showHidden: /** @type {boolean} */ (config.get('pane.showHidden')),
      hiddenCount: 0,
      sort: {
        by: /** @type {SortKey} */ (config.get('pane.sortBy')),
        reverse: /** @type {boolean} */ (config.get('pane.sortReverse')),
        directoriesFirst: /** @type {boolean} */ (config.get('pane.directoriesFirst')),
      },
      search: null,
    });
    this.#history = [{ uri: this.#uri, search: null, cursor: null }];
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
    if (this.state.search) {
      await this.#jump();
      return;
    }
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

  /**
   * Enters the directory under the cursor; on anything else, does nothing. In a search's list, goes to the
   * entry's directory instead, as `open` does.
   */
  async enter() {
    if (this.state.search) {
      await this.#jump();
      return;
    }
    const entry = this.state.entries[this.state.cursor];
    if (entry?.type === 'directory') {
      await this.#go(this.#mounted(this.state.uri, entry.name) ? TRASH_URI : canonical(childUri(this.state.uri, entry.name)), null);
    }
  }

  /**
   * Goes up to the parent directory, with the cursor on the one it came from — from a drive's root on
   * Windows, to the list of drives (2.4). A root has none. From a search's list, goes to the directory
   * searched.
   */
  async toParent() {
    if (this.state.search) {
      await this.#go(this.state.uri, null);
      return;
    }
    const up = this.state.uri === TRASH_URI ? { uri: rootUri(), name: 'trash' } : parentUri(this.state.uri);
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
    if (/^[\\/]trash(?=$|[\\/])/.test(target) && this.trash.enabled) {
      return target.slice('/trash'.length).split(/[\\/]/).filter(Boolean).reduce(childUri, TRASH_URI);
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

  /**
   * Drops the group being selected; else, unselects everything; else, in a search's list, goes to the
   * directory searched.
   */
  async unselect() {
    if (this.state.range !== null) {
      this.state.range = null;
    } else if (this.state.selected.length) {
      this.state.selected = [];
    } else if (this.state.search) {
      await this.toParent();
    }
  }

  /**
   * Starts a search of the directory shown: as it's typed in the search bar, only the entries matching are
   * listed (`search.js`: wildcards, or `/a regex/`).
   */
  async search() {
    this.#startSearch(false);
  }

  /** Starts a search of the directory shown and every one below it, walked in the background. */
  async searchTree() {
    this.#startSearch(true);
  }

  /** In a search's list, moves to the next entry — from the last, round to the first. */
  nextMatch() {
    this.#cycle(1);
  }

  /** In a search's list, moves to the previous entry — from the first, round to the last. */
  previousMatch() {
    this.#cycle(-1);
  }

  /** @param {1 | -1} step */
  #cycle(step) {
    const { search, entries, cursor } = this.state;
    if (!search) {
      this.notify('n and N go through the matches of a search: search with f or / first', 'warning');
      return;
    }
    if (entries.length) {
      this.#move((cursor + step + entries.length) % entries.length);
    }
  }

  /**
   * Opens the search bar, listing what matches as it's typed. A search typed already switches to this one's
   * reach; from a search's list, a new search looks in the directory searched.
   * @param {boolean} recursive
   */
  #startSearch(recursive) {
    if (this.state.status !== 'ready') {
      return;
    }
    const { search } = this.state;
    if (this.#typing && search) {
      if (search.recursive !== recursive) {
        search.recursive = recursive;
        if (recursive) {
          this.#startWalk();
        }
        this.#applyQuery();
      }
      return;
    }
    this.#remember();
    this.#before = {
      search: search && { query: search.query, recursive: search.recursive },
      cursor: this.state.entries[this.state.cursor]?.name ?? null,
    };
    this.#want = null;
    this.#typing = true;
    this.state.search = { query: '', recursive, typing: true, running: false, scanned: 0, error: null, capped: false };
    this.searchBar.input.setText('');
    if (recursive) {
      this.#startWalk();
    }
    this.#applyQuery();
    this.searchBar.input.focus();
  }

  /**
   * Keeps the matches — as a step of the history — and gives the focus back to the listing. An empty
   * query, or one matching nothing in the directory, goes back instead; a bad regular expression stays to
   * be fixed.
   */
  async #accept() {
    const search = this.state.search;
    if (!this.#typing || !search) {
      return;
    }
    if (search.error !== null) {
      this.notify(`Not a regular expression: ${search.error}`, 'warning');
      return;
    }
    if (search.query === '' || (!search.running && !this.state.entries.length)) {
      if (search.query !== '') {
        this.notify(`Nothing matches ${search.query}`, 'warning');
      }
      await this.#cancel();
      return;
    }
    this.#closeBar();
    this.#push({ uri: this.state.uri, search: { query: search.query, recursive: search.recursive }, cursor: null });
  }

  /** Closes the search bar and shows what the pane showed before the search: the directory, or a search. */
  async #cancel() {
    const before = this.#before;
    if (!this.#typing || !before) {
      return;
    }
    this.#closeBar();
    if (before.search) {
      this.#showSearch(before.search, before.cursor);
      return;
    }
    const { entries, hiddenCount } = this.#arrange();
    const selection = this.#selectedNames();
    const cursor = entries.findIndex((entry) => entry.name === before.cursor);
    const selected = entries.filter((entry) => selection.has(entry.name)).map((entry) => entry.name);
    Object.assign(this.state, { search: null, entries, hiddenCount, cursor: Math.max(0, cursor), selected, range: null });
  }

  /**
   * Called by `main` when the pane stops being the active one: a search being typed is kept, as `enter`
   * does.
   * @returns {Promise<void>}
   */
  async _blur() {
    if (this.#typing) {
      await this.#accept();
    }
  }

  /** Ends typing a search, if one is: the focus goes back to the listing. */
  #closeBar() {
    if (!this.#typing) {
      return;
    }
    this.#typing = false;
    this.#before = null;
    if (this.state.search) {
      this.state.search.typing = false;
    }
    this.focus();
  }

  /**
   * Shows a search of the directory shown, from the entries the pane has — a tree walked again, unless it's
   * the one walked last.
   * @param {Query} query
   * @param {string | null} focus The entry to put the cursor on once it's found.
   */
  #showSearch({ query, recursive }, focus) {
    this.#want = focus;
    this.state.search = { query, recursive, typing: false, running: false, scanned: 0, error: null, capped: false };
    if (recursive) {
      this.#startWalk();
    }
    this.#applyQuery();
  }

  /**
   * Lists the entries matching the search: of the directory, or of the tree walked so far. The cursor stays
   * on its entry while it matches — or goes to the one wanted (`#want`) once it's there — else to the
   * first; the selection keeps what still matches.
   */
  #applyQuery() {
    const search = this.state.search;
    if (!search) {
      return;
    }
    const match = matcher(search.query);
    if (match.error !== null) {
      if (search.error !== match.error) {
        search.error = match.error;
      }
      return;
    }
    if (search.error !== null) {
      search.error = null;
    }
    const { showHidden, sort, entries: before, cursor } = this.state;
    const pool = search.recursive ? this.#tree?.entries ?? [] : this.#all;
    let hiddenCount = 0;
    let over = false;
    /** @type {Entry[]} */
    const matches = [];
    for (const entry of pool) {
      if (!match.test(search.recursive ? entry.name.slice(entry.name.lastIndexOf('/') + 1) : entry.name)) {
        continue;
      }
      if (entry.hidden && !showHidden) {
        hiddenCount++;
      } else if (matches.length < MAX_MATCHES) {
        matches.push(entry);
      } else {
        over = true;
      }
    }
    const capped = over || (search.recursive && this.#tree?.capped === true);
    if (search.capped !== capped) {
      search.capped = capped;
    }
    const entries = matches.sort(comparator(sort));
    const at = this.#want ?? before[cursor]?.name ?? null;
    const index = at === null ? -1 : entries.findIndex((entry) => entry.name === at);
    if (index >= 0) {
      this.#want = null;
    }
    const selection = this.#selectedNames();
    const selected = entries.filter((entry) => selection.has(entry.name)).map((entry) => entry.name);
    Object.assign(this.state, { entries, hiddenCount, cursor: Math.max(0, index), selected, range: null });
    if (search.recursive) {
      this.#fillDetails().catch((error) => this.report(error));
    }
  }

  /**
   * Walks the directory shown for a tree search, unless the tree walked last is of it — done, or still
   * being walked — with hidden entries as they're shown now.
   */
  #startWalk() {
    const { uri, showHidden } = this.state;
    const search = /** @type {SearchState} */ (this.state.search);
    const tree = this.#tree;
    if (tree && tree.root === uri && tree.showHidden === showHidden && (tree.done || !tree.stopped)) {
      Object.assign(search, { running: !tree.done, scanned: tree.entries.length });
      return;
    }
    const id = ++this.#walkId;
    /** @type {Tree} */
    const next = { id, root: uri, showHidden, entries: [], index: new Map(), statted: new WeakSet(), done: false, stopped: false, capped: false };
    this.#tree = next;
    Object.assign(search, { running: true, scanned: 0 });
    this.#walk(next).catch((error) => this.report(error));
  }

  /**
   * Walks a tree (`search.js`), showing the matches every `WALK_UPDATE` ms, until it's done, `MAX_WALK`
   * entries are in, or it's no longer wanted: another tree, another listing, or no tree search shown. The
   * file system's own hidden marks come for the whole tree at once, alongside.
   * @param {Tree} tree
   */
  async #walk(tree) {
    const generation = this.#generation;
    const current = () => tree === this.#tree && tree.id === this.#walkId && generation === this.#generation && this.state.search?.recursive === true;
    const controller = new AbortController();
    /** @type {Set<string> | null} */
    let marked = null;
    const marking = this.fs.hiddenEntries(tree.root, { signal: controller.signal }).then((list) => {
      marked = new Set(list);
      if (!list.length || !current()) {
        return;
      }
      for (const entry of tree.entries) {
        entry.hidden ||= markedHidden(entry.name, /** @type {Set<string>} */ (marked));
      }
      if (!tree.showHidden) {
        tree.entries = tree.entries.filter((entry) => !entry.hidden);
      }
      this.#applyQuery();
    }, () => {});
    let last = Date.now();
    /** @param {string} path */
    const isMarked = (path) => marked !== null && markedHidden(path, marked);
    for await (const found of walk(this.fs, tree.root, { showHidden: tree.showHidden, current, marked: isMarked })) {
      for (const item of found) {
        // Found inside a directory marked hidden before the marks came.
        const hidden = item.hidden || isMarked(item.name);
        if (hidden && !tree.showHidden) {
          continue;
        }
        /** @type {Entry} */
        const entry = { name: item.name, type: item.type, symlink: item.symlink, executable: false, size: null, mtime: null, hidden };
        tree.entries.push(entry);
        tree.index.set(entry.name, entry);
      }
      if (tree.entries.length >= MAX_WALK) {
        tree.capped = true;
        break;
      }
      if (Date.now() - last >= WALK_UPDATE) {
        last = Date.now();
        /** @type {SearchState} */ (this.state.search).scanned = tree.entries.length;
        this.#applyQuery();
      }
    }
    if (!current()) {
      tree.stopped = !tree.done;
      controller.abort();
      return;
    }
    await marking;
    if (!current()) {
      tree.stopped = true;
      return;
    }
    tree.done = true;
    Object.assign(/** @type {SearchState} */ (this.state.search), { running: false, scanned: tree.entries.length });
    this.#applyQuery();
  }

  /**
   * Fetches the details of a tree search's matches listed — they aren't known while the tree is walked —
   * in batches, each one update, until every one listed has them; a listing sorted by size or time is
   * sorted again then.
   */
  async #fillDetails() {
    if (this.#filling) {
      return;
    }
    this.#filling = true;
    try {
      let filled = false;
      for (let tree = this.#tree; tree && tree === this.#tree && this.state.search?.recursive; ) {
        /** @type {Entry[]} */
        const pending = [];
        for (const shown of this.state.entries) {
          const entry = tree.index.get(shown.name);
          if (entry && !tree.statted.has(entry)) {
            tree.statted.add(entry);
            pending.push(entry);
            if (pending.length === STAT_BATCH) {
              break;
            }
          }
        }
        if (!pending.length) {
          break;
        }
        const root = tree.root;
        await Promise.all(pending.map((entry) => this.fs.stat(this.#child(entry.name, root)).then(({ size, mtime, executable }) => {
          Object.assign(entry, { size, mtime, executable });
        }, () => {})));
        if (tree !== this.#tree) {
          break;
        }
        const index = new Map(this.state.entries.map((entry, i) => [entry.name, i]));
        for (const { name, size, mtime, executable } of pending) {
          const i = index.get(name);
          if (i !== undefined && size !== null) {
            Object.assign(this.state.entries[i], { size, mtime, executable });
          }
        }
        filled = true;
      }
      const by = this.state.sort.by;
      if (filled && (by === 'size' || by === 'modified')) {
        this.#applyQuery();
      }
    } finally {
      this.#filling = false;
    }
  }

  /** Goes to the directory of the entry under the cursor in a search's list, the cursor on the entry. */
  async #jump() {
    if (this.#typing) {
      await this.#accept();
    }
    const entry = this.state.entries[this.state.cursor];
    if (!this.state.search || !entry) {
      return;
    }
    const { directory, name } = this.#locate(entry.name);
    await this.#go(canonical(directory), name);
  }

  /**
   * An entry listed, by its name there — a path, in a tree search's list.
   * @param {string} name
   * @param {string} [root] The directory it's in, or under. Default: the one shown.
   * @returns {string} Its URI.
   */
  #child(name, root = this.state.uri) {
    return name.split('/').reduce(childUri, root);
  }

  /**
   * @param {string} name An entry listed, by its name there.
   * @returns {{ directory: string, name: string }} The URI of the directory it's in, and its own name.
   */
  #locate(name) {
    const split = splitPath(name);
    return { directory: split.directory ? this.#child(split.directory) : this.state.uri, name: split.name };
  }

  /**
   * @param {string} name An entry listed, by its name there.
   * @param {string} other Another name in its directory.
   * @returns {string} That entry, as it would be named in the list.
   */
  #sibling(name, other) {
    const { directory } = splitPath(name);
    return directory ? `${directory}/${other}` : other;
  }

  /**
   * The directory shown, for an operation that puts entries in it.
   * @returns {string}
   * @throws {Error} A failure in a search's list, which is no directory.
   */
  #here() {
    if (this.state.search) {
      throw failure("A search's list isn't a directory: open an entry to go to its directory first");
    }
    return this.#files();
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

  /** Lists hidden entries if they aren't, and stops listing them if they are. */
  toggleHidden() {
    this.#setHidden(!this.state.showHidden);
  }

  /** Lists hidden entries, faded. */
  showHiddenEntries() {
    this.#setHidden(true);
  }

  /** Stops listing hidden entries — and unselects them. */
  hideHiddenEntries() {
    this.#setHidden(false);
  }

  /**
   * Sorts the listing.
   * @param {SortKey} by
   * @param {boolean} [reverse] Z to A, largest or newest first. Default: as it is.
   * @throws {TypeError} If `by` isn't a sort key.
   */
  sort(by, reverse = this.state.sort.reverse) {
    if (!SORT_KEYS.includes(by)) {
      throw new TypeError(`Expected ${SORT_KEYS.join(', ')}; got ${JSON.stringify(by)}`);
    }
    this.#setSort({ by, reverse: reverse === true });
  }

  /** Sorts the listing the other way round. */
  reverseSort() {
    this.#setSort({ reverse: !this.state.sort.reverse });
  }

  /** Lists directories first, or among everything else. */
  toggleDirectoriesFirst() {
    this.#setSort({ directoriesFirst: !this.state.sort.directoriesFirst });
  }

  /**
   * The sort menu: a key picks an order at once — its capital the other way round — `r` reverses the one
   * there is, and `d` puts directories first or not.
   */
  async chooseSort() {
    const { by, reverse, directoriesFirst } = this.state.sort;
    const choices = SORT_KEYS.flatMap((key) => [false, true].map((backwards) => ({
      label: describeSort({ by: key, reverse: backwards }),
      key: backwards ? key[0].toUpperCase() : key[0],
      value: `${key}${backwards ? ' reverse' : ''}`,
    })));
    choices.push(
      { label: 'Reverse the order', key: 'r', value: 'reverse' },
      { label: directoriesFirst ? 'Directories among the rest' : 'Directories first', key: 'd', value: 'directories' },
    );
    const answer = await this.openWindow(new ChoiceList({
      title: 'Sort',
      message: `Now: ${describeSort({ by, reverse })}${directoriesFirst ? ', directories first' : ''}`,
      choices,
      selected: SORT_KEYS.indexOf(by) * 2 + Number(reverse),
    }));
    if (answer === 'reverse') {
      this.reverseSort();
    } else if (answer === 'directories') {
      this.toggleDirectoriesFirst();
    } else if (typeof answer === 'string') {
      const [key, backwards] = answer.split(' ');
      this.sort(/** @type {SortKey} */ (key), backwards === 'reverse');
    }
  }

  /** @param {boolean} show */
  #setHidden(show) {
    if (show !== this.state.showHidden) {
      this.state.showHidden = show;
      this.#rearrange();
    }
  }

  /** @param {Partial<Sort>} changes */
  #setSort(changes) {
    this.state.sort = { ...this.state.sort, ...changes };
    this.#rearrange();
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
    this.#here();
    await this.#paste(content);
  }

  /** Creates symlinks here to the entries on the clipboard, cut ones too, which stay on it. */
  async pasteLinks() {
    const content = this.clipboard.content;
    if (!content) {
      this.notify('Nothing to link to: copy or cut something first', 'warning');
      return;
    }
    await this.#transfer('link', content.uris, this.#here());
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
    const names = this.#operands();
    if (!names.length) {
      return;
    }
    const here = this.#files();
    const uris = names.map((name) => this.#child(name));
    const inTrash = this.trash.contains(here);
    if (permanent !== true && this.trash.enabled && !inTrash) {
      await this.fs.createDirectory(TRASH_URI, { recursive: true });
      const outcome = await this.jobs.run({ mode: 'move', name: names[0], destination: paths.displayUri(TRASH_URI), items: uris.length }, async (job) => {
        const result = await transfer(this.fs, {
          mode: 'move',
          sources: uris,
          destination: TRASH_URI,
          resolve: async () => ({ action: 'keepBoth', all: true }),
          signal: job.signal,
          progress: (progress) => job.progress(progress),
        });
        result.created.forEach((name, i) => this.trash.record(childUri(TRASH_URI, name), result.done[i]));
        job.end(`Moved ${describe(result.created)} to the trash${result.cancelled ? ', cancelled the rest' : ''}`, result.failures.length > 0);
        return result;
      });
      outcome?.failures.forEach((error) => this.report(error));
      await this.#changed([here, TRASH_URI], null);
      if (outcome?.created.length) {
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
    const deleted = await this.#deleteForGood(uris, here);
    await this.#changed([here], null);
    if (deleted.length) {
      this.notify(`Deleted ${describe(deleted.map((uri) => names[uris.indexOf(uri)]))}`);
    }
  }

  /**
   * Puts entries in the trash back where they were deleted from — creating the directories on the way,
   * asking about a name taken there. Only in `/trash` itself.
   */
  async restore() {
    const here = this.state.uri;
    if (here !== TRASH_URI) {
      this.notify('Only entries in /trash can be restored: go there first', 'warning');
      return;
    }
    /** @type {Map<string, { uri: string, name: string }[]>} */
    const groups = new Map();
    for (const name of this.targets) {
      const uri = this.#child(name);
      const origin = this.trash.origin(uri);
      const up = origin === null ? null : parentUri(origin);
      if (!up) {
        this.report(failure(`Can't restore ${name}: where it came from isn't recorded`));
        continue;
      }
      groups.set(up.uri, [...groups.get(up.uri) ?? [], { uri, name: up.name }]);
    }
    this.#select([]);
    /** @type {string[]} */
    const restored = [];
    const count = [...groups.values()].reduce((sum, sources) => sum + sources.length, 0);
    if (count) {
      await this.jobs.run({ mode: 'restore', name: [...groups.values()][0][0].name, items: count, unit: 'items', total: count }, async (job) => {
        let before = 0;
        for (const [directory, sources] of groups) {
          job.progress({ destination: paths.displayUri(directory) });
          try {
            await this.fs.createDirectory(directory, { recursive: true });
          } catch (error) {
            this.report(error);
            continue;
          }
          const outcome = await transfer(this.fs, {
            mode: 'move',
            sources,
            destination: directory,
            resolve: (conflict) => job.ask(() => this.#ask('move', conflict, job.signal)),
            signal: job.signal,
            progress: ({ name, item }) => job.progress({ name, item: before + item, done: before + item }),
          });
          before += sources.length;
          outcome.failures.forEach((error) => this.report(error));
          this.trash.forget(outcome.done);
          restored.push(...outcome.created);
          if (outcome.cancelled) {
            break;
          }
        }
        job.end(restored.length ? `Restored ${describe(restored)}` : 'Restored nothing', restored.length < count && !job.signal.aborted);
      });
    }
    await this.#changed([here, ...groups.keys()], null);
    if (restored.length) {
      this.notify(`Restored ${describe(restored)}`);
    }
  }

  /** Deletes everything in the trash for good, after asking (`pane.confirmDelete`). */
  async emptyTrash() {
    const uris = (await this.fs.readDirectory(TRASH_URI)).map((entry) => childUri(TRASH_URI, entry.name));
    if (!uris.length) {
      this.notify('The trash is empty');
      return;
    }
    if (this.config.get('pane.confirmDelete')) {
      const confirmed = await this.openWindow(new Confirm({
        title: 'Empty the trash',
        message: `Delete ${uris.length === 1 ? 'the 1 item' : `all ${uris.length} items`} in the trash for good?`,
        yes: 'Empty',
        no: 'Cancel',
      }));
      if (confirmed !== true) {
        return;
      }
    }
    const deleted = await this.#deleteForGood(uris, TRASH_URI);
    await this.#changed([TRASH_URI], null);
    this.notify(deleted.length === uris.length ? 'Emptied the trash' : `Deleted ${deleted.length} of ${uris.length} items in the trash`);
  }

  /**
   * Deletes entries for good — whole trees — as a job, reporting each that fails; entries in the trash
   * leave its records. A cancel stops it between entries.
   * @param {string[]} uris
   * @param {string} directory Where they are.
   * @returns {Promise<string[]>} The ones deleted.
   */
  async #deleteForGood(uris, directory) {
    /** @type {string[]} */
    const deleted = [];
    const name = (/** @type {string} */ uri) => parentUri(uri)?.name ?? paths.displayUri(uri);
    await this.jobs.run({ mode: 'delete', name: name(uris[0]), destination: paths.displayUri(directory), items: uris.length, unit: 'items', total: uris.length }, async (job) => {
      for (const [i, uri] of uris.entries()) {
        if (job.signal.aborted) {
          break;
        }
        job.progress({ name: name(uri), item: i, done: i });
        try {
          await this.fs.delete(uri, { recursive: true });
          deleted.push(uri);
        } catch (error) {
          this.report(error);
        }
      }
      job.end(`Deleted ${deleted.length === 1 ? name(deleted[0]) : `${deleted.length} of ${uris.length} items`}`, deleted.length < uris.length && !job.signal.aborted);
    });
    const trashed = deleted.filter((uri) => this.trash.contains(uri));
    if (trashed.length) {
      this.trash.forget(trashed);
    }
    return deleted;
  }

  /**
   * Renames the targets: one in a prompt that starts with its name, the cursor before its extension; two
   * or more with one name, a pattern (`renameAll`).
   */
  async rename() {
    const names = this.#operands();
    if (names.length > 1) {
      await this.#renameAll(names);
      return;
    }
    const entry = this.state.entries.find((candidate) => candidate.name === names[0]);
    if (!entry) {
      return;
    }
    this.#files();
    const { directory: here, name } = this.#locate(entry.name);
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
    await this.#changed([here], this.#sibling(entry.name, renamed));
  }

  /**
   * Renames several entries with one name, a pattern (`pattern.js`: `$n`, `$i`, `$e`), in listing order;
   * the prompt previews the names it gives and refuses one taken by an entry not being renamed. It starts
   * with the extension they share, or else `$e`. Names are swapped among them through temporary ones.
   * @param {string[]} names At least two, in listing order.
   */
  async #renameAll(names) {
    this.#files();
    const types = new Map(this.state.entries.map((entry) => [entry.name, entry.type]));
    // In a tree search's list, each is renamed in its own directory.
    const entries = names.map((listed) => {
      const { directory: where, name } = this.#locate(listed);
      return { where, name, directory: types.get(listed) === 'directory' };
    });
    const count = entries.length;
    const extensions = new Set(entries.map((entry) => extension(entry.name, entry.directory)));
    /** @param {string} pattern */
    const namesFor = (pattern) => entries.map((entry, index) => expand(pattern, { index, count, name: entry.name, directory: entry.directory }));
    /**
     * @param {number} i Which entry's directory.
     * @param {string} name
     */
    const key = (i, name) => `${entries[i].where}/${process.platform === 'win32' ? name.toLowerCase() : name}`;
    const renamed = new Set(entries.map((entry, i) => key(i, entry.name)));
    const pattern = await this.openWindow(new Prompt({
      title: `Rename ${count} items`,
      message: "One name for all: $n counts from 1, $i from 0, $e is each one's extension",
      value: extensions.size === 1 ? [...extensions][0] : '$e',
      cursor: 0,
      preview: (text) => {
        if (checkPattern(text, count)) {
          return null;
        }
        const lines = namesFor(text).map((to, i) => `${entries[i].name} → ${to}`);
        return (lines.length > 4 ? [lines[0], lines[1], '…', lines.at(-1)] : lines).join('\n');
      },
      validate: async (text) => {
        const targets = namesFor(text);
        const problem = checkPattern(text, count) ?? targets.map(checkName).find(Boolean);
        if (problem) {
          return problem;
        }
        if (new Set(targets.map((name, i) => key(i, name))).size < count) {
          return 'Two would get the same name';
        }
        const taken = await Promise.all(targets.map((name, i) => (renamed.has(key(i, name)) ? null : statOrNull(this.fs, childUri(entries[i].where, name)))));
        const first = taken.findIndex(Boolean);
        return first < 0 ? null : `${targets[first]} already exists`;
      },
    }));
    if (typeof pattern !== 'string') {
      return;
    }
    const targets = namesFor(pattern);
    const moves = entries.map((entry, i) => ({ i, from: entry.name, to: targets[i] })).filter(({ from, to }) => from !== to);
    // A name another of them has now: all go through temporary names first.
    const sources = new Set(moves.map(({ i, from }) => key(i, from)));
    const swapped = moves.some(({ i, from, to }) => key(i, to) !== key(i, from) && sources.has(key(i, to)));
    const current = moves.map(({ from }) => from);
    /** @type {string[][]} */
    const steps = swapped ? [moves.map((_, i) => `.vin-rename-${process.pid}-${Date.now()}-${i}`)] : [];
    steps.push(moves.map(({ to }) => to));
    let done = 0;
    for (const [step, next] of steps.entries()) {
      for (const [i, name] of next.entries()) {
        const where = entries[moves[i].i].where;
        try {
          await this.fs.rename(childUri(where, current[i]), childUri(where, name));
          current[i] = name;
          done += Number(step === steps.length - 1);
        } catch (error) {
          this.report(error);
        }
      }
    }
    this.#select([]);
    await this.#changed([...new Set(entries.map((entry) => entry.where))], this.#sibling(names[0], targets[0]));
    this.notify(`Renamed ${done} of ${count} items`);
  }

  /**
   * Creates a file, or a directory if the name typed ends with `/` — with the directories on the way, for
   * a name with `/` inside (`src/lib/`).
   */
  async create() {
    const here = this.#here();
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

  /**
   * Lists the directory again — or searches it again, for a search's list — keeping the cursor on its
   * entry, and what's still there selected. Not while a search is typed.
   */
  async reload() {
    const { search } = this.state;
    if (this.#typing) {
      return;
    }
    await this.#list(this.state.uri, null, search && { query: search.query, recursive: search.recursive });
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
    try {
      this.#here();
    } catch (error) {
      this.report(error);
      return true;
    }
    this.#paste(content).catch((error) => this.report(error));
    return true;
  }

  /**
   * @param {'copy' | 'cut'} mode
   */
  #yank(mode) {
    const names = this.#operands();
    if (!names.length) {
      return;
    }
    this.#files();
    this.clipboard.set(mode, names.map((name) => this.#child(name)));
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
    const names = this.#operands();
    if (!names.length) {
      return;
    }
    this.#files();
    this.#select([]);
    await this.#transfer(mode, names.map((name) => this.#child(name)), destination);
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
    const result = await this.jobs.run({ mode, name: parentUri(uris[0])?.name ?? '', destination: paths.displayUri(destination), items: uris.length }, async (job) => {
      const done = await transfer(this.fs, {
        mode,
        sources: uris,
        destination,
        resolve: (conflict) => job.ask(() => this.#ask(mode, conflict, job.signal)),
        signal: job.signal,
        progress: (progress) => job.progress(progress),
      });
      job.end(this.#summary(mode, done, destination).join(', ') || 'Nothing done', done.failures.length > 0);
      return done;
    });
    /** @type {import('./operations').Outcome} */
    const outcome = result ?? { created: [], done: [], skipped: 0, failures: [], cancelled: true };
    outcome.failures.forEach((error) => this.report(error));
    const sources = mode === 'move' ? uris.map((uri) => parentUri(uri)?.uri).filter((uri) => uri !== undefined) : [];
    const here = same(destination, this.state.uri);
    await this.#changed([destination, ...sources], here ? outcome.created[0] ?? null : null);
    const parts = this.#summary(mode, outcome, destination);
    if (parts.length) {
      this.notify(parts.join(', '));
    }
    return outcome;
  }

  /**
   * What a transfer did, in words.
   * @param {Mode} mode
   * @param {import('./operations').Outcome} outcome
   * @param {string} destination
   * @returns {string[]} Parts to join with commas, the first one capitalized.
   */
  #summary(mode, outcome, destination) {
    const parts = [];
    if (outcome.created.length) {
      const here = same(destination, this.state.uri);
      parts.push(`${VERBS[mode].done} ${describe(outcome.created)}${here ? '' : ` to ${paths.displayUri(destination)}`}`);
    }
    if (outcome.skipped) {
      parts.push(`skipped ${outcome.skipped}`);
    }
    if (outcome.cancelled) {
      parts.push('cancelled the rest');
    }
    if (parts.length) {
      parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
    }
    return parts;
  }

  /**
   * Asks what to do about a name taken at the destination — until the job is cancelled, which closes the
   * question.
   * @param {Mode} mode
   * @param {Conflict} conflict
   * @param {AbortSignal} signal
   * @returns {Promise<Resolution>}
   */
  async #ask(mode, { name, directory, merge }, signal) {
    if (signal.aborted) {
      return { action: 'cancel' };
    }
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
    const question = new ChoiceList({
      title: VERBS[mode].doing,
      message: `${name} is already in ${paths.displayUri(directory)}`,
      choices,
      // Enter on the safe answer.
      selected: 2,
    });
    const dismiss = () => {
      question.close(null).catch(() => {});
    };
    signal.addEventListener('abort', dismiss, { once: true });
    let answer;
    try {
      answer = await this.openWindow(question);
    } finally {
      signal.removeEventListener('abort', dismiss);
    }
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
    const { search } = this.state;
    if (search && !this.#typing) {
      // Its entries can be anywhere below: searched again.
      await this.#list(this.state.uri, focus, { query: search.query, recursive: search.recursive });
    } else if (uris.some((uri) => same(uri, this.state.uri))) {
      await this.#list(this.state.uri, focus);
    }
  }

  /**
   * Whether an entry is where the trash shows — `trash` at the top, while the trash is on.
   * @param {string} directory
   * @param {string} name
   * @returns {boolean}
   */
  #mounted(directory, name) {
    return name === 'trash' && directory === rootUri() && this.trash.enabled;
  }

  /**
   * The targets, for an operation that changes them.
   * @returns {string[]}
   * @throws {Error} A failure for the trash's entry at the top, which only leads to it.
   */
  #operands() {
    const names = this.targets;
    if (names.some((name) => this.#mounted(this.state.uri, name))) {
      throw failure('trash here is the trash itself: go into it to change what is inside');
    }
    return names;
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
    this.#want = null;
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
    if (await this.#list(uri, focus) === 'listed') {
      this.#push({ uri, search: null, cursor: null });
    }
  }

  /**
   * Adds a step to the history after the one the pane is at, dropping any ahead — unless it's that one.
   * @param {Place} place
   */
  #push(place) {
    const here = this.#history[this.#index];
    if (here && here.uri === place.uri && sameQuery(here.search, place.search)) {
      return;
    }
    this.#history.splice(this.#index + 1, Infinity, place);
    if (this.#history.length > HISTORY_SIZE) {
      this.#history.shift();
    }
    this.#index = this.#history.length - 1;
  }

  /**
   * Moves through the history — a search in it is searched again, the cursor going back to its entry once
   * it's found. A directory there that can't be listed any more is dropped from it.
   * @param {-1 | 1} delta
   */
  async #step(delta) {
    const index = this.#index + delta;
    const place = this.#history[index];
    if (place === undefined) {
      return;
    }
    const outcome = await this.#list(place.uri, place.search ? place.cursor : null, place.search);
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
   * @param {Query | null} [search] To show a search of it instead.
   * @returns {Promise<Outcome>} Once it's shown, or not.
   */
  #list(uri, focus, search = null) {
    this.#listing = this.#load(uri, focus, search);
    return this.#listing;
  }

  /**
   * Lists a directory and shows it — or a search of it — then fetches its entries' details in batches from
   * the top (`#details`). A failure to list is reported. A search being typed ends.
   * @param {string} uri
   * @param {string | null} focus
   * @param {Query | null} [search]
   * @returns {Promise<Outcome>} Once the listing is shown, or not.
   */
  async #load(uri, focus, search = null) {
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
    const shown = this.trash.enabled && uri === rootUri()
      // The trash shows at the top, over anything real named so.
      ? [...listed.filter((entry) => entry.name !== 'trash'), { name: 'trash', type: /** @type {FileType} */ ('directory'), symlink: false }]
      : listed;
    const before = this.state.search;
    // The same view again — a reload — keeps the cursor on its entry, and what's still there selected.
    const again = uri === this.state.uri && !this.#typing && sameQuery(search, before && { query: before.query, recursive: before.recursive });
    this.#closeBar();
    this.#remember();
    this.#tree = null;
    this.#all = shown.map(({ name, type, symlink, hidden }) => ({
      name,
      type,
      symlink,
      executable: false,
      size: null,
      mtime: null,
      hidden: isHidden({ name, hidden }) && !this.#mounted(uri, name),
    }));
    const kept = new Set(again ? this.state.selected : []);
    if (search) {
      const focused = focus ?? (again ? this.state.entries[this.state.cursor]?.name ?? null : null);
      Object.assign(this.state, { uri, status: 'ready', entries: [], cursor: 0, selected: [...kept], range: null });
      this.#showSearch(search, focused);
      this.#details = this.#fetchDetails(uri, this.#all, current);
      return 'listed';
    }
    const { entries, hiddenCount } = this.#arrange();
    const name = focus ?? this.#positions.get(uri) ?? null;
    const found = name === null ? -1 : entries.findIndex((entry) => entry.name === name);
    // An entry gone from the same directory — deleted, moved — leaves the cursor on its row.
    const cursor = Math.max(0, found >= 0 ? found : again ? Math.min(this.state.cursor, entries.length - 1) : 0);
    const selected = entries.filter((entry) => kept.has(entry.name)).map((entry) => entry.name);
    Object.assign(this.state, { uri, status: 'ready', entries, hiddenCount, cursor, selected, range: null, search: null });
    this.#details = this.#fetchDetails(uri, this.#all, current);
    return 'listed';
  }

  /**
   * The entries to list, from `#all`: without the hidden ones unless they're shown, in the pane's order.
   * @returns {{ entries: Entry[], hiddenCount: number }}
   */
  #arrange() {
    const { showHidden, sort } = this.state;
    const shown = showHidden ? this.#all : this.#all.filter((entry) => !entry.hidden);
    return { entries: [...shown].sort(comparator(sort)), hiddenCount: this.#all.length - shown.length };
  }

  /**
   * Lists the directory's entries again, as the view options now say, without reading it: the cursor stays
   * on its entry — or, if that's hidden now, goes to the nearest one still listed — and so does the
   * selection, ending any group, less what's hidden now.
   */
  #rearrange() {
    const search = this.state.search;
    if (search) {
      if (search.recursive) {
        this.#startWalk();
      }
      this.#applyQuery();
      return;
    }
    const { entries: before, cursor } = this.state;
    const selection = this.#selectedNames();
    const { entries, hiddenCount } = this.#arrange();
    const index = new Map(entries.map((entry, i) => [entry.name, i]));
    const near = [...before.slice(cursor), ...before.slice(0, cursor).reverse()].find((entry) => index.has(entry.name));
    const selected = entries.filter((entry) => selection.has(entry.name)).map((entry) => entry.name);
    Object.assign(this.state, { entries, hiddenCount, cursor: near ? /** @type {number} */ (index.get(near.name)) : 0, selected, range: null });
  }

  /**
   * Remembers the entry under the cursor in the directory shown, for when the pane comes back to it.
   */
  #remember() {
    const { uri, status, entries, cursor, search } = this.state;
    const name = entries[cursor]?.name;
    if (status !== 'ready' || name === undefined) {
      return;
    }
    if (search) {
      const place = this.#history[this.#index];
      if (place?.search && place.uri === uri && sameQuery(place.search, { query: search.query, recursive: search.recursive })) {
        place.cursor = name;
      }
      return;
    }
    this.#positions.delete(uri);
    this.#positions.set(uri, name);
    if (this.#positions.size > POSITIONS_SIZE) {
      this.#positions.delete(/** @type {string} */ (this.#positions.keys().next().value));
    }
  }

  /**
   * Fetches the entries' details in batches, each batch one update — or, while one is slow to answer (a
   * disconnected network drive takes seconds), one update of what has come every `SLOW_STAT` ms, so it
   * doesn't hold up the rest. An entry that can't be read (gone since, or no permission) keeps none.
   *
   * The entries listed come first, in their order, then the hidden ones not listed; once all are in, a
   * listing sorted by size or time is sorted again.
   * @param {string} uri The directory listed.
   * @param {Entry[]} all Its entries (`#all`), which take the details.
   * @param {() => boolean} current Whether this listing is still the latest.
   */
  async #fetchDetails(uri, all, current) {
    const byName = new Map(all.map((entry) => [entry.name, entry]));
    // A tree search's matches below the directory aren't among its entries.
    const listed = this.state.entries.map((entry) => byName.get(entry.name)).filter((entry) => entry !== undefined);
    const shown = new Set(listed);
    const entries = [...listed, ...all.filter((entry) => !shown.has(entry))];
    for (let start = 0; start < entries.length; start += STAT_BATCH) {
      /** @type {Map<Entry, import('../../../fs/file-system').FileStat>} */
      const arrived = new Map();
      let done = false;
      const batch = Promise.all(entries.slice(start, start + STAT_BATCH).map((entry) => this.fs.stat(childUri(uri, entry.name))
        .then((stat) => {
          arrived.set(entry, stat);
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
        const index = new Map(this.state.entries.map((entry, i) => [entry.name, i]));
        for (const [entry, { size, mtime, executable, free }] of arrived) {
          const details = { size, mtime, executable, ...(free === undefined ? {} : { free }) };
          Object.assign(entry, details);
          const i = index.get(entry.name);
          if (i !== undefined) {
            Object.assign(this.state.entries[i], details);
          }
        }
        arrived.clear();
      }
    }
    if (current() && (this.state.sort.by === 'size' || this.state.sort.by === 'modified')) {
      this.#rearrange();
    }
  }
}

module.exports = Pane;
