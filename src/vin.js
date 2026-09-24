const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Minimal shape `Vin` relies on until the `Handler` base class exists.
 * @typedef {object} HandlerLike
 * @property {string} name Unique name the UI and CLI use to address the handler.
 */

/** Manages every handler and the event system between them, and starts the UI. */
class Vin {
  constructor() {
    /** @type {Map<string, HandlerLike>} */
    this.handlers = new Map();
  }

  /**
   * @param {HandlerLike} handler
   * @throws {Error} If a handler with the same name is already registered.
   */
  register(handler) {
    if (this.handlers.has(handler.name)) {
      throw new Error(`Handler "${handler.name}" is already registered`);
    }
    this.handlers.set(handler.name, handler);
  }

  /**
   * @param {string} name
   * @returns {HandlerLike | undefined}
   */
  getHandler(name) {
    return this.handlers.get(name);
  }

  /**
   * Loads the built TUI (`npm run build`) and runs it until it exits.
   * @returns {Promise<void>}
   */
  async start() {
    // The UI is ESM (Ink can't be require()d), so this is the one dynamic import across the boundary.
    const entry = pathToFileURL(path.join(__dirname, '..', 'dist', 'tui.mjs')).href;
    /** @type {{ start(vin: Vin): Promise<void> }} */
    const ui = await import(entry);
    await ui.start(this);
  }
}

module.exports = Vin;
