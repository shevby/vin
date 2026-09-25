const Handler = require('../../handler');
const TextField = require('../text-field/text-field');

/**
 * What a prompt checks its answer with: an error message to show, or nothing if the answer is fine.
 * @typedef {(value: string) => string | null | undefined | Promise<string | null | undefined>} Validate
 */

/**
 * What a prompt shows under the text as it's typed — what the answer would do — or nothing.
 * @typedef {(value: string) => string | null} Preview
 */

/**
 * A question answered with a line of text, as a window: `await this.openWindow(new Prompt({ message:
 * 'New name', value: 'notes.txt', cursor: 5 }))`. Closes with the text, or `null` if dismissed (Escape).
 *
 * The text is edited in its `input` sub-handler, a `TextField`, which has the focus. `enter` submits; if
 * `validate` returns a message, it's shown and the prompt stays open until the text changes and is
 * submitted again. `preview`, if given, shows under the text what it would do, kept up to date as it's
 * edited.
 * @extends {Handler<{ title: string | null, message: string | null, error: string | null, preview: string | null }>}
 */
class Prompt extends Handler {
  static kind = 'prompt';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [{ method: 'submit', title: 'Submit the text' }],
    keybindings: [{ key: 'enter', command: 'prompt.submit' }],
  };

  /** @type {{ title: string | null, message: string | null }} */
  #initial;
  /** @type {Validate | undefined} */
  #validate;
  /** @type {Preview | undefined} */
  #preview;
  /** The text it starts with. */
  #value = '';

  /**
   * @param {object} [options]
   * @param {string} [options.message] The question, above the text.
   * @param {string} [options.title] Shown above the question.
   * @param {string} [options.value] The text it starts with. Default: empty.
   * @param {number} [options.cursor] Where the cursor starts, in characters. Default: at the end.
   * @param {boolean} [options.secret] Hide the text (a password or passphrase). Default: false.
   * @param {Validate} [options.validate] Checks the text on submit.
   * @param {Preview} [options.preview] Describes the text, below it, whenever it changes.
   * @param {string} [options.name] Its handler name. Default: `prompt`.
   * @throws {TypeError} If an option has the wrong type.
   */
  constructor({ message, title, value, cursor, secret, validate, preview, name = 'prompt' } = {}) {
    super(name);
    for (const [field, text] of Object.entries({ message, title })) {
      if (text !== undefined && typeof text !== 'string') {
        throw new TypeError(`Prompt "${name}": ${field} must be a string`);
      }
    }
    for (const [field, callback] of Object.entries({ validate, preview })) {
      if (callback !== undefined && typeof callback !== 'function') {
        throw new TypeError(`Prompt "${name}": ${field} must be a function`);
      }
    }
    this.#initial = { title: title ?? null, message: message ?? null };
    this.#validate = validate;
    this.#preview = preview;
    this.#value = value ?? '';
    /** Where the text is edited. */
    this.input = new TextField('input', {
      value,
      cursor,
      secret,
      onChange: () => {
        if (this.state.error !== null) {
          this.state.error = null;
        }
        this.#describe();
      },
    });
    this.add(this.input);
  }

  onInit() {
    // The text field is initialized after this, so the preview starts from the text it's given.
    this.update({ ...this.#initial, error: null, preview: this.#preview?.(this.#value) ?? null });
    this.input.focus();
  }

  /** Shows the preview of the text as it is now. */
  #describe() {
    if (!this.#preview) {
      return;
    }
    const preview = this.#preview(this.input.value) ?? null;
    if (preview !== this.state.preview) {
      this.state.preview = preview;
    }
  }

  /**
   * Closes with the text, unless `validate` finds a problem with it — shown as `error` instead.
   * @returns {Promise<void>}
   */
  async submit() {
    const { value } = this.input;
    const error = await this.#validate?.(value);
    if (typeof error === 'string' && error) {
      this.state.error = error;
      return;
    }
    await this.close(value);
  }
}

module.exports = Prompt;
