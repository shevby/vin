const Handler = require('../../handler');
const { paths } = require('../../paths');
const Pane = require('./pane/pane');

/** @typedef {'left' | 'right'} Side */

/** @type {readonly Side[]} */
const SIDES = ['left', 'right'];

/**
 * The main window: two panes side by side, `main.left` and `main.right`, one of them active — it has the
 * focus, so pane commands act on it. In single-pane mode only the active pane is shown, full width, and
 * switching panes swaps which one that is, as in vifm.
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
  }

  /**
   * Makes the other pane active.
   */
  switchPane() {
    this.activate(this.state.active === 'left' ? 'right' : 'left');
  }

  /**
   * Makes a pane active, giving it the focus.
   * @param {Side} side
   * @throws {TypeError} If `side` isn't `left` or `right`.
   */
  activate(side) {
    if (!SIDES.includes(side)) {
      throw new TypeError(`Expected "left" or "right", got ${JSON.stringify(side)}`);
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
}

module.exports = Main;
