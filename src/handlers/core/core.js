const Handler = require('../../handler');
const { isChord } = require('../../keys');
const { KeySequencer } = require('../../keymap');
const { log } = require('../../log');

/**
 * @typedef {import('../../state').Data} Data
 * @typedef {InstanceType<typeof import('../../contributions').Registry>} Registry
 */

/**
 * The built-in `core` handler: vin's own API for the UI, beyond any one window.
 * - Its state mirrors the contribution registry — `contributions.commands`, `contributions.keybindings`, … —
 *   so the UI reads them like any other state.
 * - It runs commands (`execute`) and resolves key presses into them (`press`); `pendingKeys` shows a
 *   sequence in progress (`g` while waiting for `g g`).
 * @extends {Handler<{ contributions: { [point: string]: Data[] }, pendingKeys: string }>}
 */
class Core extends Handler {
  static kind = 'core';

  /** @type {Registry} */
  #registry;
  /** @type {(() => void) | null} */
  #unsubscribe = null;
  /** @type {InstanceType<typeof KeySequencer>} */
  #keys;

  /** @param {Registry} registry */
  constructor(registry) {
    super('core');
    this.#registry = registry;
    this.#keys = new KeySequencer({
      candidates: (focus) =>
        registry.activeKeybindings(focus).map(({ binding, command, handler, depth }) => ({
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
    this.update({
      contributions: Object.fromEntries(registry.points.map((point) => [point, registry.get(point)])),
      pendingKeys: '',
    });
    this.#unsubscribe = registry.subscribe((point) => {
      this.state.contributions[point] = registry.get(point);
    });
  }

  onDispose() {
    this.#unsubscribe?.();
    this.#keys.reset();
  }

  /**
   * Runs a command from the TUI on the handler of its kind nearest to the focused one.
   * @param {string} command A command id, e.g. `pane.down`.
   * @param {string | null} [focus] Path of the focused handler, e.g. `main.left`.
   * @param {Data[]} [args]
   * @returns {Promise<unknown>} The command method's result.
   */
  execute(command, focus = null, args = []) {
    return this.#registry.execute(command, { focus, args });
  }

  /**
   * Handles a key press from the UI: runs the command it completes, or waits for the rest of a sequence.
   * The command runs in the background; a failure is logged.
   * @param {string} chord One canonical chord (`src/keys.js`), e.g. `j`, `shift+g`, `ctrl+w`.
   * @param {string | null} [focus] Path of the focused handler, e.g. `main.left`.
   * @returns {boolean} Whether a keybinding used the key — if not, the UI may handle it itself.
   * @throws {TypeError} If `chord` isn't one canonical chord.
   */
  press(chord, focus = null) {
    if (!isChord(chord)) {
      throw new TypeError(`"${chord}" isn't a single key in canonical notation, e.g. "j", "shift+g", "ctrl+w"`);
    }
    return this.#keys.press(chord, focus);
  }
}

module.exports = Core;
