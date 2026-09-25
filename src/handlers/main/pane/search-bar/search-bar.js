const Handler = require('../../../../handler');
const TextField = require('../../../text-field/text-field');

/**
 * Where a pane's search is typed (2.12), in the pane's bottom border: a `TextField` (`input`) that has the
 * focus while a search is typed, with `enter` to keep the matches and `escape` to go back. Everything else
 * falls through to the pane — the arrows and page keys move through the matches as they're typed. The pane
 * owns it for good and only focuses it, so the UI follows one handler for the pane's life.
 * @extends {Handler<{}>}
 */
class SearchBar extends Handler {
  static kind = 'searchBar';

  /** @type {import('../../../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'accept', title: 'Keep the matches', description: 'Lists the matches in the pane, to move through with n and N' },
      { method: 'cancel', title: 'Cancel the search', description: 'Goes back to what the pane showed before' },
    ],
    keybindings: [
      { key: 'enter', command: 'searchBar.accept' },
      { key: 'escape', command: 'searchBar.cancel' },
    ],
  };

  /** @type {() => void | Promise<void>} */
  #onAccept;
  /** @type {() => void | Promise<void>} */
  #onCancel;

  /**
   * @param {string} name
   * @param {object} options
   * @param {(query: string) => void} options.onChange After each change of the text.
   * @param {() => void | Promise<void>} options.onAccept On `enter`.
   * @param {() => void | Promise<void>} options.onCancel On `escape`.
   */
  constructor(name, { onChange, onAccept, onCancel }) {
    super(name);
    this.#onAccept = onAccept;
    this.#onCancel = onCancel;
    /** Where the query is edited. */
    this.input = this.add(new TextField('input', { onChange }));
  }

  /** Keeps the matches. */
  async accept() {
    await this.#onAccept();
  }

  /** Goes back to what the pane showed before the search. */
  async cancel() {
    await this.#onCancel();
  }
}

module.exports = SearchBar;
