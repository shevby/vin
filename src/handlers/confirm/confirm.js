const Handler = require('../../handler');

/** @typedef {'yes' | 'no'} Button */

/**
 * A yes/no question, as a window: `if (await this.openWindow(new Confirm({ message: 'Delete 3 files?' })))`.
 * Closes with `true` or `false`, or `null` if dismissed (Escape) — treat that as no.
 *
 * Keys: `y` and `n` answer at once; `left`/`right`/`h`/`l`/`tab` move between the buttons; `enter` presses
 * the highlighted one. The caller picks which starts highlighted, so a destructive question can start on
 * No and a stray Enter does no harm.
 * @extends {Handler<{ title: string | null, message: string, yes: string, no: string, selected: Button }>}
 */
class Confirm extends Handler {
  static kind = 'confirm';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'yes', title: 'Answer yes' },
      { method: 'no', title: 'Answer no' },
      { method: 'select', title: 'Highlight a button' },
      { method: 'toggle', title: 'Highlight the other button' },
      { method: 'accept', title: 'Press the highlighted button' },
    ],
    keybindings: [
      { key: 'y', command: 'confirm.yes' },
      { key: 'n', command: 'confirm.no' },
      { key: 'enter', command: 'confirm.accept' },
      { key: 'left', command: 'confirm.select', args: ['yes'] },
      { key: 'h', command: 'confirm.select', args: ['yes'] },
      { key: 'right', command: 'confirm.select', args: ['no'] },
      { key: 'l', command: 'confirm.select', args: ['no'] },
      { key: 'tab', command: 'confirm.toggle' },
      { key: 'shift+tab', command: 'confirm.toggle' },
    ],
  };

  /** @type {{ title: string | null, message: string, yes: string, no: string, selected: Button }} */
  #initial;

  /**
   * @param {object} options
   * @param {string} options.message The question.
   * @param {string} [options.title] Shown above it.
   * @param {string} [options.yes] The yes button's label. Default: `Yes`.
   * @param {string} [options.no] The no button's label. Default: `No`.
   * @param {Button} [options.initial] The button highlighted at first. Default: `yes`.
   * @param {string} [options.name] Its handler name. Default: `confirm`.
   * @throws {TypeError} If `message` or a label isn't a non-empty string, or `initial` isn't a button.
   */
  constructor({ message, title, yes = 'Yes', no = 'No', initial = 'yes', name = 'confirm' }) {
    super(name);
    for (const [field, value] of Object.entries({ message, yes, no })) {
      if (typeof value !== 'string' || !value) {
        throw new TypeError(`Confirm "${name}" needs a non-empty string ${field}`);
      }
    }
    if (title !== undefined && typeof title !== 'string') {
      throw new TypeError(`Confirm "${name}": title must be a string`);
    }
    checkButton(initial);
    this.#initial = { title: title ?? null, message, yes, no, selected: initial };
  }

  onInit() {
    this.update({ ...this.#initial });
  }

  yes() {
    return this.close(true);
  }

  no() {
    return this.close(false);
  }

  /** @param {Button} button */
  select(button) {
    checkButton(button);
    this.state.selected = button;
  }

  toggle() {
    this.state.selected = this.state.selected === 'yes' ? 'no' : 'yes';
  }

  accept() {
    return this.close(this.state.selected === 'yes');
  }
}

/**
 * @param {unknown} button
 * @throws {TypeError} If it isn't `yes` or `no`.
 */
function checkButton(button) {
  if (button !== 'yes' && button !== 'no') {
    throw new TypeError(`Expected "yes" or "no", got ${JSON.stringify(button)}`);
  }
}

module.exports = Confirm;
