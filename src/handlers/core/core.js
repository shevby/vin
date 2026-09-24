const Handler = require('../../handler');

/**
 * @typedef {import('../../state').Data} Data
 * @typedef {InstanceType<typeof import('../../contributions').Registry>} Registry
 */

/**
 * The built-in `core` handler: vin's own API for the UI, beyond any one window. Its state mirrors the
 * contribution registry — `contributions.commands`, `contributions.keybindings`, … — so the UI reads them
 * like any other state.
 * @extends {Handler<{ contributions: { [point: string]: Data[] } }>}
 */
class Core extends Handler {
  static kind = 'core';

  /** @type {Registry} */
  #registry;
  /** @type {(() => void) | null} */
  #unsubscribe = null;

  /** @param {Registry} registry */
  constructor(registry) {
    super('core');
    this.#registry = registry;
  }

  onInit() {
    const registry = this.#registry;
    this.update({ contributions: Object.fromEntries(registry.points.map((point) => [point, registry.get(point)])) });
    this.#unsubscribe = registry.subscribe((point) => {
      this.state.contributions[point] = registry.get(point);
    });
  }

  onDispose() {
    this.#unsubscribe?.();
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
}

module.exports = Core;
