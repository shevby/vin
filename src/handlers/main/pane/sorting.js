const { extension } = require('./pattern');

/**
 * The order of a pane's listing, and which entries are hidden (2.11). Kept apart from the pane, which
 * applies them.
 */

/**
 * What entries are sorted by: `name` in natural order (`file2` before `file10`), `extension` then name,
 * `size` (a directory counts as nothing), or `modified` time.
 * @typedef {'name' | 'extension' | 'size' | 'modified'} SortKey
 */

/**
 * @typedef {object} Sort
 * @property {SortKey} by
 * @property {boolean} reverse Z to A, largest or newest first.
 * @property {boolean} directoriesFirst Directories — symlinks to them too — before everything else, in
 *   the same order among themselves.
 */

/** @type {readonly SortKey[]} */
const SORT_KEYS = ['name', 'extension', 'size', 'modified'];

/**
 * @typedef {object} Sortable
 * @property {string} name
 * @property {import('../../../fs/file-system').FileType} type
 * @property {number | null} size
 * @property {number | null} mtime
 */

/** Natural order (`file2` before `file10`), ignoring case and accents. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Names in natural order; names equal but for case or accents in code-point order, so the order is stable.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * @param {Sortable} entry
 * @param {SortKey} by
 * @returns {number | string | null} What it's sorted by; `null` for a detail not known yet.
 */
function key(entry, by) {
  switch (by) {
    case 'extension':
      return extension(entry.name, entry.type === 'directory');
    case 'size':
      return entry.type === 'directory' ? 0 : entry.size;
    case 'modified':
      return entry.mtime;
    default:
      return entry.name;
  }
}

/**
 * The comparison for a sort. Entries whose size or time isn't known yet — it comes after the listing —
 * go last, in name order, however it's reversed; equal keys go by name.
 * @param {Sort} sort
 * @returns {(a: Sortable, b: Sortable) => number}
 */
function comparator({ by, reverse, directoriesFirst }) {
  const sign = reverse ? -1 : 1;
  return (a, b) => {
    if (directoriesFirst) {
      const directories = Number(b.type === 'directory') - Number(a.type === 'directory');
      if (directories) {
        return directories;
      }
    }
    const [x, y] = [key(a, by), key(b, by)];
    if (x === null || y === null) {
      return x === y ? compareNames(a.name, b.name) : x === null ? 1 : -1;
    }
    const order = typeof x === 'string' && typeof y === 'string' ? compareNames(x, y) : Number(x) - Number(y);
    return sign * (order || compareNames(a.name, b.name));
  };
}

/**
 * Whether an entry is hidden: a name starting with `.`, as on Unix, or the file system's own mark (the
 * Hidden attribute on Windows).
 * @param {{ name: string, hidden?: boolean }} entry
 * @returns {boolean}
 */
function isHidden(entry) {
  return entry.name.startsWith('.') || entry.hidden === true;
}

/**
 * A sort in words, as the sort menu and the pane's border say it: `size, largest first`.
 * @param {Pick<Sort, 'by' | 'reverse'>} sort
 * @returns {string}
 */
function describeSort({ by, reverse }) {
  if (!reverse) {
    return by === 'size' ? 'size, smallest first' : by === 'modified' ? 'modified, oldest first' : by;
  }
  return by === 'size' ? 'size, largest first' : by === 'modified' ? 'modified, newest first' : `${by}, Z to A`;
}

module.exports = { SORT_KEYS, comparator, compareNames, isHidden, describeSort };
