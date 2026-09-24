const Handler = require('../../handler');
const { isChord } = require('../../keys');
const { KeySequencer } = require('../../keymap');
const { log } = require('../../log');

/**
 * @typedef {import('../../state').Data} Data
 * @typedef {InstanceType<typeof import('../../contributions').Registry>} Registry
 * @typedef {InstanceType<typeof import('../../windows').WindowStack>} WindowStack
 * @typedef {import('../../windows').WindowInfo} WindowInfo
 */

/**
 * The built-in `core` handler: vin's own API for the UI, beyond any one window.
 * - Its state mirrors the contribution registry — `contributions.commands`, `contributions.keybindings`, … —
 *   so the UI reads them like any other state.
 * - `windows` lists the open windows, bottom to top, each with its focus; the UI draws them in that order,
 *   and the top one's focus gets the keys.
 * - It runs commands (`execute`) and resolves key presses into them (`press`) for the focus; `pendingKeys`
 *   shows a sequence in progress (`g` while waiting for `g g`).
 * @extends {Handler<{ contributions: { [point: string]: Data[] }, windows: WindowInfo[], pendingKeys: string }>}
 */
class Core extends Handler {
  static kind = 'core';

  static contributes = {
    commands: [{ method: 'closeWindow', title: 'Close window', description: 'Closes the window on top, unless it is the main window' }],
    keybindings: [{ key: 'escape', command: 'core.closeWindow' }],
  };

  /** @type {Registry} */
  #registry;
  /** @type {WindowStack} */
  #windows;
  /** @type {(() => void)[]} */
  #unsubscribe = [];
  /** @type {InstanceType<typeof KeySequencer>} */
  #keys;

  /**
   * @param {Registry} registry
   * @param {WindowStack} windows
   */
  constructor(registry, windows) {
    super('core');
    this.#registry = registry;
    this.#windows = windows;
    this.#keys = new KeySequencer({
      candidates: (focus) =>
        registry.activeKeybindings(focus, windows.top?.path).map(({ binding, command, handler, depth }) => ({
          keys: binding.keys,
          depth,
          run: () => {
            handler.call(command.method, ...binding.args).catch((error) => {
              log.error(`Keybinding "${binding.key}" → ${binding.command} on "${handler.path}" failed:`, error);
            });
          },
        })),
      onPending: (pending) => {
        this.state.pendingKeys = pending.join(' ');
      },
    });
  }

  onInit() {
    const registry = this.#registry;
    const windows = this.#windows;
    this.update({
      contributions: Object.fromEntries(registry.points.map((point) => [point, registry.get(point)])),
      windows: windows.windows,
      pendingKeys: '',
    });
    let focus = windows.focused;
    this.#unsubscribe.push(
      registry.subscribe((point) => {
        this.state.contributions[point] = registry.get(point);
      }),
      windows.subscribe(() => {
        this.state.windows = windows.windows;
        if (windows.focused !== focus) {
          // A sequence started in one window doesn't carry over to another.
          focus = windows.focused;
          this.#keys.reset();
        }
      }),
    );
  }

  onDispose() {
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      unsubscribe();
    }
    this.#keys.reset();
  }

  /**
   * Runs a command from the TUI on the handler of its kind nearest to the focus.
   * @param {string} command A command id, e.g. `pane.down`.
   * @param {Data[]} [args]
   * @returns {Promise<unknown>} The command method's result.
   */
  execute(command, args = []) {
    return this.#registry.execute(command, { focus: this.#windows.focused?.path ?? null, args });
  }

  /**
   * Handles a key press from the UI: runs the command it completes for the focus, or waits for the rest of
   * a sequence. The command runs in the background; a failure is logged.
   * @param {string} chord One canonical chord (`src/keys.js`), e.g. `j`, `shift+g`, `ctrl+w`.
   * @returns {boolean} Whether a keybinding used the key — if not, the UI may handle it itself.
   * @throws {TypeError} If `chord` isn't one canonical chord.
   */
  press(chord) {
    if (!isChord(chord)) {
      throw new TypeError(`"${chord}" isn't a single key in canonical notation, e.g. "j", "shift+g", "ctrl+w"`);
    }
    return this.#keys.press(chord, this.#windows.focused?.path ?? null);
  }

  /**
   * Closes the window on top with `null` — the Escape key — unless it's the main window.
   * @returns {Promise<boolean>} Whether a window was closed.
   */
  closeWindow() {
    return this.#windows.closeTop();
  }
}

module.exports = Core;
