const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Registry } = require('./contributions');
const { EventBus } = require('./events');
const Handler = require('./handler');
const Core = require('./handlers/core/core');
const { setHost } = require('./host');
const { createInProcessTransport } = require('./transport');
const { log } = require('./log');
const { WindowStack } = require('./windows');

/**
 * Manages every handler, the event system, the contribution registry, and the window stack between them,
 * and starts the UI.
 * The built-in `core` handler is always registered first.
 */
class Vin {
  /** @type {import('./host').Host} */
  #host;

  constructor() {
    /**
     * Top-level handlers by name, in registration order.
     * @type {Map<string, Handler>}
     */
    this.handlers = new Map();
    /**
     * The event bus between handlers; see `Handler#emit` and `Handler#on`.
     * @readonly
     */
    this.events = new EventBus();
    /**
     * Extension points and what handlers contribute to them; see `Handler.contributes`.
     * @readonly
     */
    this.registry = new Registry();
    /**
     * The open windows and the focus; see `openWindow()` and `Handler#openWindow`.
     * @readonly
     */
    this.windows = new WindowStack();
    this.#host = {
      events: this.events,
      windows: this.windows,
      attach: (handler) => {
        const detach = this.registry.attach(handler);
        return () => {
          this.windows.forget(handler);
          detach();
        };
      },
    };
    this.register(new Core(this.registry, this.windows));
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
    setHost(handler, this.#host);
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
   * Runs a command (`pane.down`) on the handler of its kind nearest to `focus`, or the only one there is.
   * @param {string} command
   * @param {{ focus?: string | null, surface?: 'tui' | 'cli', args?: unknown[] }} [options]
   * @returns {Promise<unknown>}
   * @throws {Error} If the command doesn't exist, isn't available on `surface`, or has nothing to run on.
   */
  execute(command, options) {
    return this.registry.execute(command, options);
  }

  /**
   * Opens a registered handler as a lasting window — the main window — initializing it first if needed.
   * It stays open until the handler is disposed; overlays open over it with `Handler#openWindow`.
   * @param {string} path
   * @returns {Promise<void>}
   * @throws {Error} If there's no such handler, it fails to initialize, or it's already open.
   */
  async openWindow(path) {
    const handler = this.resolve(path);
    await handler.init();
    this.windows.open(handler);
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
      /** @type {{ start(transport: import('./transport').Transport): Promise<void> }} */
      const ui = await import(entry);
      // The TUI shares this process, so it gets a transport that calls straight in.
      await ui.start(createInProcessTransport(this));
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
