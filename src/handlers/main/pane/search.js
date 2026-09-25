const { childUri } = require('../../../fs/file-system');
const { isHidden } = require('./sorting');

/**
 * @typedef {InstanceType<typeof import('../../../fs/file-system').FileSystem>} FileSystem
 * @typedef {import('../../../fs/file-system').FileType} FileType
 */

/**
 * What a search matches names with (2.12): its `test`, or why the query isn't one.
 * @typedef {{ test: (name: string) => boolean, error: null } | { test: null, error: string }} Matcher
 */

/**
 * One entry of a tree walked (`walk()`).
 * @typedef {object} Found
 * @property {string} name Its path from the directory searched, `/`-separated: `src/lib/x.js`.
 * @property {FileType} type
 * @property {boolean} symlink
 * @property {boolean} hidden Hidden itself, or inside a hidden directory.
 */

/** Flags a regular expression may carry; `g` and `y` would make `test` remember where it stopped. */
const FLAGS = /^[dimsuv]*$/;

/**
 * Reads a search query (2.12):
 * - `/…/flags` is a JavaScript regular expression — the closing `/` optional while it's typed (`/re.+x`),
 *   as typed, case included (`/rep/i` ignores it);
 * - anything else is a wildcard pattern found anywhere in a name: `*` any characters, `?` one —
 *   `rep` finds `report.pdf`, `*.md` any name with `.md` in it — ignoring case unless it has a capital
 *   (smart case, as in vim).
 *
 * An empty query matches everything.
 * @param {string} query
 * @returns {Matcher}
 */
function matcher(query) {
  if (query.startsWith('/')) {
    const closed = /^\/(.*)\/([a-z]*)$/s.exec(query);
    const [source, flags] = closed && FLAGS.test(closed[2]) ? [closed[1], closed[2]] : [query.slice(1), ''];
    let pattern;
    try {
      pattern = new RegExp(source, flags);
    } catch (error) {
      return { test: null, error: /** @type {Error} */ (error).message.replace(/^Invalid regular expression: /, '') };
    }
    return { test: (name) => pattern.test(name), error: null };
  }
  const source = [...query].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[\\^$.+()[\]{}|/]/g, '\\$&'))).join('');
  const pattern = new RegExp(source, /\p{Lu}/u.test(query) ? 'su' : 'isu');
  return { test: (name) => pattern.test(name), error: null };
}

/**
 * The name of an entry found in a tree, and the path of its directory from the one searched.
 * @param {string} path `src/lib/x.js`, or `x.js` at the top.
 * @returns {{ directory: string, name: string }} `src/lib` and `x.js`; `''` for the top.
 */
function splitPath(path) {
  const slash = path.lastIndexOf('/');
  return { directory: path.slice(0, slash < 0 ? 0 : slash), name: path.slice(slash + 1) };
}

/**
 * Walks a tree breadth-first — the directory's own entries first, then theirs — yielding each directory's
 * entries as they're read. It doesn't follow symlinks (nor junctions), so it can't loop; a directory it
 * can't read is skipped. Hidden entries (a name starting with `.`; the file system's own mark is left to the
 * caller, as it costs a process per directory on Windows — see `FileSystem#hiddenEntries`) and whatever is
 * inside hidden directories are marked `hidden`, and unless `showHidden`, left out and not walked into.
 * @param {FileSystem} fs
 * @param {string} root The directory's URI.
 * @param {object} options
 * @param {boolean} options.showHidden
 * @param {() => boolean} options.current Whether to go on; checked after every read.
 * @param {(path: string) => boolean} [options.marked] Whether the file system marks an entry hidden, as far
 *   as the caller knows yet (by its path from the root).
 * @returns {AsyncGenerator<Found[]>}
 */
async function* walk(fs, root, { showHidden, current, marked = () => false }) {
  /** @type {{ uri: string, prefix: string, hidden: boolean }[]} */
  const queue = [{ uri: root, prefix: '', hidden: false }];
  for (let next = queue.shift(); next && current(); next = queue.shift()) {
    let listed;
    try {
      listed = await fs.readDirectory(next.uri, { attributes: false });
    } catch {
      continue;
    }
    if (!current()) {
      return;
    }
    /** @type {Found[]} */
    const found = [];
    for (const entry of listed) {
      const name = next.prefix + entry.name;
      const hidden = next.hidden || isHidden(entry) || marked(name);
      if (hidden && !showHidden) {
        continue;
      }
      found.push({ name, type: entry.type, symlink: entry.symlink, hidden });
      if (entry.type === 'directory' && !entry.symlink) {
        queue.push({ uri: childUri(next.uri, entry.name), prefix: `${name}/`, hidden });
      }
    }
    yield found;
  }
}

module.exports = { matcher, splitPath, walk };
