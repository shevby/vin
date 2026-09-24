/**
 * Key notation, VS Code style: a chord is modifiers and a key joined by `+` (`ctrl+w`, `shift+tab`), and a
 * sequence is chords separated by spaces (`g g`, `ctrl+w h`).
 *
 * - Modifiers: `ctrl`, `alt`, `shift`, in any order and case; the canonical order is `ctrl+alt+shift+`.
 * - Named keys (any case): the ones in `NAMED_KEYS` — `space`, `enter`, `escape`, arrows, `f1`–`f12`, ….
 * - Any other key is the single character it types: `j`, `:`, `?`, `+`. An uppercase letter means
 *   `shift+` the lowercase one, so `G` and `shift+g` are the same chord (canonically `shift+g`). `shift`
 *   can't combine with other characters: a terminal sends `:`, not `shift+;`, so write `:`.
 */

/** Keys written by name; everything else is a single character. */
const NAMED_KEYS = new Set([
  'space', 'tab', 'enter', 'escape', 'backspace', 'delete', 'insert',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = /** @type {const} */ (['ctrl', 'alt', 'shift']);

/**
 * Parses a key sequence into canonical chords.
 * @param {string} text E.g. `g g`, `ctrl+w h`, `G`.
 * @returns {string[]} E.g. `['g', 'g']`, `['ctrl+w', 'h']`, `['shift+g']`.
 * @throws {TypeError} If a chord is malformed, with the reason.
 */
function parseKeys(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('Empty key sequence');
  }
  return text.trim().split(/\s+/).map((chord) => parseChord(chord, text));
}

/**
 * @param {string} chord
 * @param {string} text The whole sequence, for error messages.
 * @returns {string}
 */
function parseChord(chord, text) {
  /** @type {Set<string>} */
  const modifiers = new Set();
  let rest = chord;
  for (let match; (match = /^(ctrl|alt|shift)\+(.+)$/i.exec(rest)); rest = match[2]) {
    const modifier = match[1].toLowerCase();
    if (modifiers.has(modifier)) {
      throw new TypeError(`Key "${text}": "${chord}" repeats ${modifier}`);
    }
    modifiers.add(modifier);
  }

  let key = rest;
  if (NAMED_KEYS.has(rest.toLowerCase())) {
    key = rest.toLowerCase();
  } else if ([...rest].length !== 1) {
    const hint = MODIFIERS.includes(/** @type {any} */ (rest.toLowerCase()))
      ? `"${rest}" needs a key after it, e.g. "${rest.toLowerCase()}+x"`
      : `"${rest}" isn't a key; use one character or one of: ${[...NAMED_KEYS].join(', ')}`;
    throw new TypeError(`Key "${text}": ${hint}`);
  } else if (rest !== rest.toLowerCase()) {
    // An uppercase letter is shift + the lowercase one.
    key = rest.toLowerCase();
    modifiers.add('shift');
  } else if (modifiers.has('shift') && rest === rest.toUpperCase()) {
    throw new TypeError(`Key "${text}": shift combines only with letters and named keys; write the character it types instead (":" rather than "shift+;")`);
  }
  return [...MODIFIERS.filter((modifier) => modifiers.has(modifier)), key].join('+');
}

/**
 * Whether `chord` is one canonical chord, as `parseKeys` produces and the UI sends.
 * @param {unknown} chord
 * @returns {chord is string}
 */
function isChord(chord) {
  if (typeof chord !== 'string') {
    return false;
  }
  try {
    const chords = parseKeys(chord);
    return chords.length === 1 && chords[0] === chord;
  } catch {
    return false;
  }
}

module.exports = { parseKeys, isChord, NAMED_KEYS };
