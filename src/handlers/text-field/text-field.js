const Handler = require('../../handler');

/** A character of a word, for word motions and deletions: letters, digits, `_`. */
const WORD = /[\p{L}\p{N}_]/u;

/**
 * One line of editable text, as a sub-handler of whatever needs one — a prompt (`src/handlers/prompt/`),
 * later the command line (6) and plugin form fields (4.6). The text and the cursor live in its state, so
 * editing works the same from any UI:
 * - typed characters and pastes are inserted at the cursor (`onText`) — line breaks become spaces, other
 *   control characters are dropped;
 * - editing keys are ordinary commands and keybindings (readline-style: `ctrl+a`, `ctrl+w`, `alt+b`, …),
 *   which user config can remap;
 * - a UI with its own text fields (a GUI) sends the whole text instead (`setText`).
 *
 * The cursor counts characters (code points), from 0 (before the first) to the length (after the last).
 * @extends {Handler<{ value: string, cursor: number, secret: boolean }>}
 */
class TextField extends Handler {
  static kind = 'textField';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'left', title: 'Cursor left' },
      { method: 'right', title: 'Cursor right' },
      { method: 'wordLeft', title: 'Cursor to the previous word' },
      { method: 'wordRight', title: 'Cursor past the next word' },
      { method: 'home', title: 'Cursor to the start' },
      { method: 'end', title: 'Cursor to the end' },
      { method: 'deleteBack', title: 'Delete the character before the cursor' },
      { method: 'deleteForward', title: 'Delete the character under the cursor' },
      { method: 'deleteWordBack', title: 'Delete the word before the cursor' },
      { method: 'deleteWordForward', title: 'Delete the word after the cursor' },
      { method: 'deleteToStart', title: 'Delete to the start' },
      { method: 'deleteToEnd', title: 'Delete to the end' },
    ],
    keybindings: [
      { key: 'left', command: 'textField.left' },
      { key: 'ctrl+b', command: 'textField.left' },
      { key: 'right', command: 'textField.right' },
      { key: 'ctrl+f', command: 'textField.right' },
      { key: 'ctrl+left', command: 'textField.wordLeft' },
      { key: 'alt+b', command: 'textField.wordLeft' },
      { key: 'ctrl+right', command: 'textField.wordRight' },
      { key: 'alt+f', command: 'textField.wordRight' },
      { key: 'home', command: 'textField.home' },
      { key: 'ctrl+a', command: 'textField.home' },
      { key: 'end', command: 'textField.end' },
      { key: 'ctrl+e', command: 'textField.end' },
      // Terminals send Ctrl+H as Backspace.
      { key: 'backspace', command: 'textField.deleteBack' },
      { key: 'delete', command: 'textField.deleteForward' },
      { key: 'ctrl+d', command: 'textField.deleteForward' },
      { key: 'ctrl+w', command: 'textField.deleteWordBack' },
      { key: 'alt+backspace', command: 'textField.deleteWordBack' },
      { key: 'alt+d', command: 'textField.deleteWordForward' },
      { key: 'ctrl+u', command: 'textField.deleteToStart' },
      { key: 'ctrl+k', command: 'textField.deleteToEnd' },
    ],
  };

  /** @type {{ value: string, cursor: number | undefined, secret: boolean }} */
  #initial;
  /** @type {((value: string) => void) | undefined} */
  #onChange;

  /**
   * @param {string} name
   * @param {object} [options]
   * @param {string} [options.value] The text it starts with. Default: empty.
   * @param {number} [options.cursor] Where the cursor starts. Default: at the end.
   * @param {boolean} [options.secret] Hide the text on screen (a password). Default: false.
   * @param {(value: string) => void} [options.onChange] Called after each change of the text.
   */
  constructor(name, { value = '', cursor, secret = false, onChange } = {}) {
    super(name);
    if (typeof value !== 'string') {
      throw new TypeError(`Text field "${name}" needs a string value`);
    }
    this.#initial = { value: clean(value), cursor, secret: Boolean(secret) };
    this.#onChange = onChange;
  }

  onInit() {
    const { value, cursor, secret } = this.#initial;
    this.update({ value, cursor: clamp(cursor ?? Infinity, [...value].length), secret });
  }

  /**
   * The text now.
   * @returns {string}
   */
  get value() {
    return this.state.value;
  }

  /**
   * Inserts typed or pasted text at the cursor.
   * @param {string} text
   * @returns {boolean} Always true: a text field takes every character.
   */
  onText(text) {
    const chars = [...this.state.value];
    const { cursor } = this.state;
    const inserted = [...clean(text)];
    chars.splice(cursor, 0, ...inserted);
    this.#set(chars, cursor + inserted.length);
    return true;
  }

  /**
   * Replaces the whole text — for a UI that edits it itself.
   * @param {string} value
   * @param {number} [cursor] Default: at the end.
   * @throws {TypeError} If `value` isn't a string or `cursor` isn't a number.
   */
  setText(value, cursor) {
    if (typeof value !== 'string' || (cursor !== undefined && typeof cursor !== 'number')) {
      throw new TypeError('setText takes a string and, optionally, a cursor position');
    }
    const chars = [...clean(value)];
    this.#set(chars, cursor ?? chars.length);
  }

  left() {
    this.#move(this.state.cursor - 1);
  }

  right() {
    this.#move(this.state.cursor + 1);
  }

  wordLeft() {
    this.#move(wordStart([...this.state.value], this.state.cursor));
  }

  wordRight() {
    this.#move(wordEnd([...this.state.value], this.state.cursor));
  }

  home() {
    this.#move(0);
  }

  end() {
    this.#move(Infinity);
  }

  deleteBack() {
    this.#delete(this.state.cursor - 1, this.state.cursor);
  }

  deleteForward() {
    this.#delete(this.state.cursor, this.state.cursor + 1);
  }

  deleteWordBack() {
    this.#delete(wordStart([...this.state.value], this.state.cursor), this.state.cursor);
  }

  deleteWordForward() {
    this.#delete(this.state.cursor, wordEnd([...this.state.value], this.state.cursor));
  }

  deleteToStart() {
    this.#delete(0, this.state.cursor);
  }

  deleteToEnd() {
    this.#delete(this.state.cursor, Infinity);
  }

  /** @param {number} cursor */
  #move(cursor) {
    const next = clamp(cursor, [...this.state.value].length);
    if (next !== this.state.cursor) {
      this.state.cursor = next;
    }
  }

  /**
   * Deletes the characters from `start` up to `end`, leaving the cursor at `start`.
   * @param {number} start
   * @param {number} end
   */
  #delete(start, end) {
    const chars = [...this.state.value];
    const from = clamp(start, chars.length);
    const to = clamp(end, chars.length);
    if (from < to) {
      chars.splice(from, to - from);
      this.#set(chars, from);
    }
  }

  /**
   * @param {string[]} chars
   * @param {number} cursor
   */
  #set(chars, cursor) {
    const value = chars.join('');
    const changed = value !== this.state.value;
    this.state.value = value;
    this.state.cursor = clamp(cursor, chars.length);
    if (changed) {
      this.#onChange?.(value);
    }
  }
}

/**
 * Text fit for one line: a line break at the end (a pasted line) is dropped, others become spaces, and
 * other control characters are removed.
 * @param {string} text
 * @returns {string}
 */
function clean(text) {
  return text
    .replace(/[\r\n]+$/, '')
    .replace(/\r\n|[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '');
}

/**
 * @param {number} value
 * @param {number} max
 * @returns {number} `value` within 0..`max`.
 */
function clamp(value, max) {
  return Math.min(Math.max(0, value), max);
}

/**
 * Where the word before `cursor` starts — skipping non-word characters first, as readline does.
 * @param {string[]} chars
 * @param {number} cursor
 * @returns {number}
 */
function wordStart(chars, cursor) {
  let i = cursor;
  while (i > 0 && !WORD.test(chars[i - 1])) {
    i--;
  }
  while (i > 0 && WORD.test(chars[i - 1])) {
    i--;
  }
  return i;
}

/**
 * Where the word after `cursor` ends — skipping non-word characters first.
 * @param {string[]} chars
 * @param {number} cursor
 * @returns {number}
 */
function wordEnd(chars, cursor) {
  let i = cursor;
  while (i < chars.length && !WORD.test(chars[i])) {
    i++;
  }
  while (i < chars.length && WORD.test(chars[i])) {
    i++;
  }
  return i;
}

module.exports = TextField;
