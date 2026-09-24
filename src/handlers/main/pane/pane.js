const Handler = require('../../../handler');

/**
 * One pane of the main window (`src/handlers/main/`): a view of one directory, addressed by URI so a pane
 * can later show any provider's files (`src/fs/`). Its listing comes with 2.2, navigation with 2.3.
 * @extends {Handler<{ uri: string }>}
 */
class Pane extends Handler {
  static kind = 'pane';

  /** @type {string} */
  #uri;

  /**
   * @param {string} name `left` or `right`, in the main window.
   * @param {object} options
   * @param {string} options.uri The directory it shows, e.g. `file:///C:/Users/me`.
   * @throws {TypeError} If `uri` isn't a URI.
   */
  constructor(name, { uri }) {
    super(name);
    if (typeof uri !== 'string' || !/^[a-z][a-z\d+.-]*:/i.test(uri)) {
      throw new TypeError(`Pane "${name}" needs a directory URI, got ${JSON.stringify(uri)}`);
    }
    this.#uri = uri;
  }

  onInit() {
    this.update({ uri: this.#uri });
  }
}

module.exports = Pane;
