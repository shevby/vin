/** @typedef {import('ink').Key} Key */

/** Ink's flags for keys that type no character, and their names in key notation (`src/keys.js`). */
const NAMED = /** @type {const} */ ([
  ['upArrow', 'up'],
  ['downArrow', 'down'],
  ['leftArrow', 'left'],
  ['rightArrow', 'right'],
  ['pageUp', 'pageup'],
  ['pageDown', 'pagedown'],
  ['home', 'home'],
  ['end', 'end'],
  ['return', 'enter'],
  ['escape', 'escape'],
  ['tab', 'tab'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
]);

/**
 * Turns what Ink's `useInput` reports into one canonical chord (`src/keys.js`): `j`, `shift+g`, `ctrl+w`,
 * `alt+x`, `cmd+c`, `shift+tab`, `space`, `enter`.
 *
 * Terminals don't report everything: `ctrl+shift+<letter>` arrives as `ctrl+<letter>`, and Cmd (Ink's
 * `super`) only through the kitty keyboard protocol. Function keys come through with no name, so they give
 * `null` — vin leaves them to the OS anyway.
 * @param {string} input
 * @param {Key} key
 * @returns {string | null} `null` for input that isn't one key (a paste, an unknown sequence).
 */
export function toChord(input, key) {
  /** @type {string | undefined} */
  let name = NAMED.find(([flag]) => key[flag])?.[1];
  let shift = Boolean(name && key.shift);
  if (!name) {
    if (input === ' ') {
      name = 'space';
    } else if ([...input].length === 1) {
      name = input.toLowerCase();
      // Uppercase is shift; for other characters shift is already in the character (`:`, not `shift+;`).
      shift = name !== input;
    } else {
      return null;
    }
  }
  // Ink reports a second Escape (and some Alt sequences) as meta+escape; treat it as plain escape.
  const alt = key.meta && name !== 'escape';
  return [key.ctrl && 'ctrl', alt && 'alt', shift && 'shift', key.super && 'cmd', name].filter(Boolean).join('+');
}
