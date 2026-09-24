const Handler = require('../../handler');
const { cloneData } = require('../../state');

/**
 * @typedef {import('../../state').Data} Data
 */

/**
 * One option of a choice list.
 * @typedef {object} Choice
 * @property {string} label
 * @property {string} [key] One character that picks it at once, e.g. `o` for Overwrite.
 * @property {string} [description] Shown after the label, dimmed.
 * @property {Data} [value] What the list closes with when it's picked. Default: its index.
 */

/**
 * @typedef {object} ChoiceState
 * @property {string} label
 * @property {string | null} key
 * @property {string | null} description
 */

/**
 * A list to pick one option from, as a window: `await this.openWindow(new ChoiceList({ message: 'x
 * exists', choices: [{ label: 'Overwrite', key: 'o', value: 'overwrite' }, …] }))`. Closes with the
 * picked option's `value`, or `null` if dismissed (Escape).
 *
 * Keys: `j`/`k` and the arrows move, `g g`/`shift+g` and Home/End jump to the ends, `enter` picks the
 * highlighted option, and an option's own `key` picks it at once — before any keybinding of that key.
 * @extends {Handler<{ title: string | null, message: string | null, choices: ChoiceState[], selected: number }>}
 */
class ChoiceList extends Handler {
  static kind = 'choiceList';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'up', title: 'Highlight the previous option' },
      { method: 'down', title: 'Highlight the next option' },
      { method: 'first', title: 'Highlight the first option' },
      { method: 'last', title: 'Highlight the last option' },
      { method: 'accept', title: 'Pick the highlighted option' },
    ],
    keybindings: [
      { key: 'up', command: 'choiceList.up' },
      { key: 'k', command: 'choiceList.up' },
      { key: 'ctrl+p', command: 'choiceList.up' },
      { key: 'down', command: 'choiceList.down' },
      { key: 'j', command: 'choiceList.down' },
      { key: 'ctrl+n', command: 'choiceList.down' },
      { key: 'home', command: 'choiceList.first' },
      { key: 'g g', command: 'choiceList.first' },
      { key: 'end', command: 'choiceList.last' },
      { key: 'shift+g', command: 'choiceList.last' },
      { key: 'enter', command: 'choiceList.accept' },
    ],
  };

  /** @type {{ title: string | null, message: string | null, choices: ChoiceState[], selected: number }} */
  #initial;
  /** @type {Data[]} */
  #values;

  /**
   * @param {object} options
   * @param {Choice[]} options.choices At least one.
   * @param {string} [options.message] Shown above the options.
   * @param {string} [options.title] Shown above the message.
   * @param {number} [options.selected] The option highlighted at first, by index. Default: 0.
   * @param {string} [options.name] Its handler name. Default: `choiceList`.
   * @throws {TypeError} If there are no choices, one is malformed, two share a key, or `selected` is out of
   *   range.
   */
  constructor({ choices, message, title, selected = 0, name = 'choiceList' }) {
    super(name);
    if (!Array.isArray(choices) || !choices.length) {
      throw new TypeError(`Choice list "${name}" needs at least one choice`);
    }
    for (const [field, text] of Object.entries({ message, title })) {
      if (text !== undefined && typeof text !== 'string') {
        throw new TypeError(`Choice list "${name}": ${field} must be a string`);
      }
    }
    /** @type {Set<string>} */
    const keys = new Set();
    const states = choices.map((choice, i) => {
      const where = `Choice list "${name}", choice ${i}`;
      const { label, key, description } = choice ?? {};
      if (typeof label !== 'string' || !label) {
        throw new TypeError(`${where} needs a non-empty string label`);
      }
      if (key !== undefined && (typeof key !== 'string' || [...key].length !== 1 || /\s/.test(key))) {
        throw new TypeError(`${where}: key must be one character, e.g. "o"`);
      }
      if (key !== undefined && keys.has(key)) {
        throw new TypeError(`${where}: key "${key}" is already another choice's`);
      }
      if (key !== undefined) {
        keys.add(key);
      }
      if (description !== undefined && typeof description !== 'string') {
        throw new TypeError(`${where}: description must be a string`);
      }
      return { label, key: key ?? null, description: description ?? null };
    });
    if (!Number.isInteger(selected) || selected < 0 || selected >= choices.length) {
      throw new TypeError(`Choice list "${name}": selected must be an index of a choice`);
    }
    this.#values = choices.map((choice, i) =>
      choice.value === undefined ? i : /** @type {Data} */ (cloneData(choice.value, ['value'], { what: `Choice list "${name}", choice ${i}` })),
    );
    this.#initial = { title: title ?? null, message: message ?? null, choices: states, selected };
  }

  onInit() {
    this.update({ ...this.#initial });
  }

  /**
   * Picks the option whose `key` was typed.
   * @param {string} text
   * @returns {boolean} Whether an option has that key.
   */
  onText(text) {
    const index = this.state.choices.findIndex((choice) => choice.key === text);
    if (index < 0) {
      return false;
    }
    this.state.selected = index;
    this.close(this.#values[index]).catch((error) => this.report(error));
    return true;
  }

  up() {
    this.#select(this.state.selected - 1);
  }

  down() {
    this.#select(this.state.selected + 1);
  }

  first() {
    this.#select(0);
  }

  last() {
    this.#select(this.state.choices.length - 1);
  }

  accept() {
    return this.close(this.#values[this.state.selected]);
  }

  /** @param {number} index */
  #select(index) {
    const next = Math.min(Math.max(0, index), this.state.choices.length - 1);
    if (next !== this.state.selected) {
      this.state.selected = next;
    }
  }
}

module.exports = ChoiceList;
