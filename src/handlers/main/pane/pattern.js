/**
 * Renaming several entries with one name (2.8): a pattern whose `$` tokens differ for each entry, in the
 * order they're listed.
 * - `$n` — its number, from 1; `$i` — its index, from 0. Both are padded with zeros to the digits of how
 *   many entries there are: 99 entries give `01`…`99`, 100 give `001`…`100` (and `$i` `000`…`099`).
 * - `$e` — its own extension, with the dot (`.mkv`), or nothing: a directory has none.
 * - `$$` — a `$`.
 */

/** A token, or a `$` that doesn't start one. */
const TOKEN = /\$(.?)/gsu;

/**
 * An entry's extension, with the dot: from the last dot on, unless that's its first character (`.bashrc`
 * has none), and none for a directory.
 * @param {string} name
 * @param {boolean} directory
 * @returns {string}
 */
function extension(name, directory) {
  const dot = name.lastIndexOf('.');
  return directory || dot <= 0 ? '' : name.slice(dot);
}

/**
 * What's wrong with a pattern for this many entries, if anything.
 * @param {string} pattern
 * @param {number} count
 * @returns {string | null}
 */
function checkPattern(pattern, count) {
  let counted = false;
  for (const [token, letter] of pattern.matchAll(TOKEN)) {
    if (letter === 'n' || letter === 'i') {
      counted = true;
    } else if (letter !== 'e' && letter !== '$') {
      return `${token === '$' ? 'A $ at the end' : token} isn't a token: $n counts from 1, $i from 0, $e is the extension, $$ is $`;
    }
  }
  return counted || count < 2 ? null : 'Put $n or $i in it, so the names differ';
}

/**
 * The name the pattern gives one entry.
 * @param {string} pattern Checked with `checkPattern()`.
 * @param {object} entry
 * @param {number} entry.index From 0, in the order listed.
 * @param {number} entry.count How many are renamed.
 * @param {string} entry.name Its name now.
 * @param {boolean} entry.directory
 * @returns {string}
 */
function expand(pattern, { index, count, name, directory }) {
  const digits = String(count).length;
  /** @param {number} n */
  const pad = (n) => String(n).padStart(digits, '0');
  return pattern.replace(TOKEN, (token, letter) => {
    switch (letter) {
      case 'n':
        return pad(index + 1);
      case 'i':
        return pad(index);
      case 'e':
        return extension(name, directory);
      case '$':
        return '$';
      default:
        return token;
    }
  });
}

module.exports = { checkPattern, expand, extension };
