const path = require('node:path');
const { pathToFileURL } = require('node:url');
const Handler = require('./handler');
const { log } = require('./log');

/** Manages every handler and the event system between them, and starts the UI. */
class Vin {
  constructor() {
    /**
     * Top-level handlers by name, in registration order.
     * @type {Map<string, Handler>}
     */
    this.handlers = new Map();
  }

  /**
   * Registers a top-level handler.
   * @param {Handler} handler
   * @throws {Error} If it isn't a `Handler`, is a sub-handler, or its name is taken.
   */
  register(handler) {
    if (!(handler instanceof Handler)) {
      throw new TypeError('Only a Handler can be registered');
    }
    if (handler.parent) {
      throw new Error(`Handler "${handler.path}" is a sub-handler; register its top-level handler instead`);
    }
    if (this.handlers.has(handler.name)) {
      throw new Error(`Handler "${handler.name}" is already registered`);
    }
    this.handlers.set(handler.name, handler);
  }

  /**
   * Finds a handler by its full dotted path (`main`, `main.left`).
   * @param {string} path
   * @returns {Handler}
   * @throws {Error} If any segment of the path doesn't exist.
   */
  resolve(path) {
    const dot = path.indexOf('.');
    const name = dot < 0 ? path : path.slice(0, dot);
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`No handler "${name}"`);
    }
    return dot < 0 ? handler : handler.resolve(path.slice(dot + 1));
  }

  /**
   * Calls a handler method by its full dotted path (`main.left.navigate`).
   * @param {string} path At least a handler and a method.
   * @param {...unknown} args
   * @returns {Promise<unknown>}
   * @throws {Error} If the path has no method, a handler doesn't exist, or the method isn't callable.
   */
  async call(path, ...args) {
    const dot = path.indexOf('.');
    if (dot < 0) {
      throw new Error(`"${path}" names no method; expected "<handler>.<method>"`);
    }
    return this.resolve(path.slice(0, dot)).call(path.slice(dot + 1), ...args);
  }

  /**
   * Initializes every top-level handler (and so their sub-handlers), in registration order.
   * @returns {Promise<void>}
   */
  async init() {
    for (const handler of this.handlers.values()) {
      await handler.init();
    }
  }

  /**
   * Disposes every top-level handler in reverse registration order, even if some fail.
   * @returns {Promise<void>}
   * @throws {Error | AggregateError} The failure, or all of them if more than one handler failed.
   */
  async dispose() {
    /** @type {unknown[]} */
    const errors = [];
    for (const handler of [...this.handlers.values()].reverse()) {
      await handler.dispose().catch((error) => errors.push(error));
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Disposing handlers failed');
    }
  }

  /**
   * Initializes the handlers, loads the built TUI (`npm run build`) and runs it until it exits, then
   * disposes the handlers.
   * @returns {Promise<void>}
   */
  async start() {
    let failed = true;
    try {
      await this.init();
      // The UI is ESM (Ink can't be require()d), so this is the one dynamic import across the boundary.
      const entry = pathToFileURL(path.join(__dirname, '..', 'dist', 'tui.mjs')).href;
      /** @type {{ start(vin: Vin): Promise<void> }} */
      const ui = await import(entry);
      await ui.start(this);
      failed = false;
    } finally {
      await this.dispose().catch((error) => {
        if (!failed) {
          throw error;
        }
        // Don't let a cleanup failure hide the error that got us here.
        log.error('Disposing handlers after a failed start:', error);
      });
    }
  }
}

module.exports = Vin;
