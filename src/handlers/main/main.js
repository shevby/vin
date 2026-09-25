const Handler = require('../../handler');
const { paths } = require('../../paths');
const Pane = require('./pane/pane');
const JobList = require('../jobs/jobs');
const { same } = require('./pane/operations');

/** @typedef {'left' | 'right'} Side */

/** @type {readonly Side[]} */
const SIDES = ['left', 'right'];

/**
 * The main window: two panes side by side, `main.left` and `main.right`, one of them active — it has the
 * focus, so pane commands act on it. In single-pane mode only the active pane is shown, full width, and
 * switching panes swaps which one that is, as in vifm.
 *
 * Entries go from the active pane straight to the other's directory (2.7): `copyToOther` and
 * `moveToOther`. When a pane's operation changes the directory the other shows, the other reloads.
 * `showJobs` opens the jobs window (2.10).
 * @extends {Handler<{ active: Side, singlePane: boolean }>}
 */
class Main extends Handler {
  static kind = 'main';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'switchPane', title: 'Switch pane', description: 'Makes the other pane active' },
      { method: 'activate', title: 'Activate a pane', description: 'Makes the left or the right pane active' },
      { method: 'only', title: 'Show one pane', description: 'Shows only the active pane, full width' },
      { method: 'split', title: 'Show both panes', description: 'Shows both panes side by side' },
      { method: 'copyToOther', title: 'Copy to the other pane', description: "Copies the active pane's entries to the other pane's directory" },
      { method: 'moveToOther', title: 'Move to the other pane', description: "Moves the active pane's entries to the other pane's directory" },
      { method: 'showJobs', title: 'Show the jobs', description: 'Lists the copies, moves and deletions running, and those just over, to cancel one' },
    ],
    keybindings: [
      { key: 'tab', command: 'main.switchPane' },
      { key: 'ctrl+w w', command: 'main.switchPane' },
      { key: 'ctrl+w ctrl+w', command: 'main.switchPane' },
      { key: 'ctrl+w h', command: 'main.activate', args: ['left'] },
      { key: 'ctrl+w l', command: 'main.activate', args: ['right'] },
      { key: 'ctrl+w o', command: 'main.only' },
      { key: 'ctrl+w ctrl+o', command: 'main.only' },
      { key: 'ctrl+w v', command: 'main.split' },
      { key: 'y p', command: 'main.copyToOther' },
      { key: 'd p', command: 'main.moveToOther' },
      { key: 't', command: 'main.showJobs' },
    ],
    configuration: [
      {
        key: 'singlePane',
        type: 'boolean',
        default: false,
        description: 'Start with one pane shown instead of two (ctrl+w o and ctrl+w v switch while vin runs).',
      },
    ],
  };

  /**
   * @param {object} [options]
   * @param {string} [options.left] The directory the left pane shows, as a URI. Default: the current one.
   * @param {string} [options.right] The directory the right pane shows, as a URI. Default: the current one.
   */
  constructor({ left, right } = {}) {
    super('main');
    const here = paths.toUri(process.cwd());
    /** @readonly */
    this.left = this.add(new Pane('left', { uri: left ?? here }));
    /** @readonly */
    this.right = this.add(new Pane('right', { uri: right ?? here }));
  }

  onInit() {
    this.update({ active: 'left', singlePane: /** @type {boolean} */ (this.config.get('main.singlePane')) });
    // Before the window opens, so it opens with the left pane focused.
    this.left.focus();
    for (const [pane, other] of [[this.left, this.right], [this.right, this.left]]) {
      this.on(`${pane.path}.changed`, (/** @type {any} */ { uris }) => {
        if (/** @type {string[]} */ (uris).some((uri) => same(uri, other.state.uri))) {
          other.reload().catch((error) => this.report(error));
        }
      });
    }
  }

  /** Copies the active pane's entries — selected, or under the cursor — to the other pane's directory. */
  async copyToOther() {
    const [from, to] = this.#panes();
    await from.copyTo(to.state.uri);
  }

  /** Moves the active pane's entries to the other pane's directory. */
  async moveToOther() {
    const [from, to] = this.#panes();
    await from.moveTo(to.state.uri);
  }

  /**
   * @returns {[Pane, Pane]} The active pane, then the other.
   */
  #panes() {
    return this.state.active === 'left' ? [this.left, this.right] : [this.right, this.left];
  }

  /**
   * Makes the other pane active.
   */
  switchPane() {
    this.activate(this.state.active === 'left' ? 'right' : 'left');
  }

  /**
   * Makes a pane active, giving it the focus. The other keeps a search being typed there, as `enter` does.
   * @param {Side} side
   * @throws {TypeError} If `side` isn't `left` or `right`.
   */
  activate(side) {
    if (!SIDES.includes(side)) {
      throw new TypeError(`Expected "left" or "right", got ${JSON.stringify(side)}`);
    }
    if (side !== this.state.active) {
      // Its focus goes back to its listing before this one takes it.
      this[this.state.active]._blur().catch((error) => this.report(error));
    }
    this.state.active = side;
    this[side].focus();
  }

  /**
   * Shows only the active pane, full width. The other keeps its directory for when it's shown again.
   */
  only() {
    this.state.singlePane = true;
  }

  /**
   * Shows both panes side by side.
   */
  split() {
    this.state.singlePane = false;
  }

  /**
   * Opens the jobs window, over the panes, until it's closed.
   * @returns {Promise<void>}
   */
  async showJobs() {
    await this.openWindow(new JobList());
  }
}

module.exports = Main;
