const { log } = require('./log');
const { cloneData } = require('./state');

/**
 * @typedef {import('./state').Data} Data
 * @typedef {InstanceType<typeof import('./handler')>} Handler
 */

/**
 * One open window, as `core` shows it to the UI.
 * @typedef {object} WindowInfo
 * @property {number} id Unique to this opening: a window closed and opened again at the same path gets a new
 *   one, so the UI knows to drop what it kept for the old handler.
 * @property {string} path The window's handler, e.g. `main` or `main.left.confirm`.
 * @property {string} kind That handler's kind, which picks the UI component that draws it.
 * @property {string} focus The focused handler within the window: the window's handler or one of its
 *   descendants. It's kept while the window is covered, so the focus comes back when the overlay closes.
 */

/**
 * @typedef {object} Entry
 * @property {number} id
 * @property {Handler} handler
 * @property {Handler} focus
 * @property {boolean} transient Opened by `Handler#openWindow()`: closed by `close()` or Escape, and disposed
 *   then. Other windows (the main window) stay until their handler is disposed.
 * @property {(result: Data) => void} resolve Settles `openWindow()`'s promise.
 */

/**
 * Whether `handler` is `ancestor` or one of its descendants.
 * @param {Handler} handler
 * @param {Handler} ancestor
 */
function isWithin(handler, ancestor) {
  for (let node = /** @type {Handler | null} */ (handler); node; node = node.parent) {
    if (node === ancestor) {
      return true;
    }
  }
  return false;
}

/**
 * The windows open in the UI, bottom to top, and the focus within each. Only the top window's focus
 * counts: keys go to it and the handlers around it, up to the window's own handler — never to the windows
 * it covers.
 *
 * Handlers reach it through `openWindow()`, `close()`, and `focus()`; `core` mirrors it in its state.
 */
class WindowStack {
  /** @type {Entry[]} */
  #entries = [];
  /**
   * Handlers of windows being closed, so a second `close()` (a key pressed twice) is ignored instead of
   * closing the window below.
   * @type {WeakSet<Handler>}
   */
  #closing = new WeakSet();
  /** @type {Set<() => void>} */
  #listeners = new Set();
  #lastId = 0;
  /** @type {import('./messages').ErrorReporter} */
  #report;

  /**
   * @param {object} [options]
   * @param {import('./messages').ErrorReporter} [options.report] Gets a window's failure to dispose, which
   *   has no caller to throw to. Default: logs it.
   */
  constructor({ report = (error, context) => log.error(`${context}:`, error) } = {}) {
    this.#report = report;
  }

  /**
   * The open windows, bottom to top.
   * @returns {WindowInfo[]}
   */
  get windows() {
    return this.#entries.map((entry) => ({ id: entry.id, path: entry.handler.path, kind: entry.handler.kind, focus: entry.focus.path }));
  }

  /**
   * The top window's handler, or `null` when none is open.
   * @returns {Handler | null}
   */
  get top() {
    return this.#entries.at(-1)?.handler ?? null;
  }

  /**
   * The handler keys go to — the focus within the top window — or `null` when none is open.
   * @returns {Handler | null}
   */
  get focused() {
    return this.#entries.at(-1)?.focus ?? null;
  }

  /**
   * Opens an initialized handler as a lasting window — the main window. It stays until the handler is
   * disposed.
   * @param {Handler} handler
   * @throws {Error} If it's already open.
   */
  open(handler) {
    if (this.#entries.some((entry) => entry.handler === handler)) {
      throw new Error(`Window "${handler.path}" is already open`);
    }
    this.#entries.push({ id: ++this.#lastId, handler, focus: handler, transient: false, resolve: () => {} });
    this.#notify();
  }

  /**
   * Adds `window` to `opener` as a sub-handler, initializes it, and opens it on top, focused.
   * @param {Handler} opener
   * @param {Handler} window
   * @returns {Promise<Data>} What the window is closed with: `close(result)`'s result, or `null` if it's
   *   dismissed (Escape) or disposed.
   * @throws {Error} If it can't be added or fails to initialize — it's removed again then.
   */
  async openTransient(opener, window) {
    opener.add(window);
    try {
      await window.init();
      if (window.parent !== opener) {
        throw new Error(`Window "${window.name}" was removed from "${opener.path}" while it opened`);
      }
    } catch (error) {
      if (window.parent === opener) {
        await opener.remove(window.name).catch((disposeError) => {
          this.#report(disposeError, `Disposing window "${window.path}" after it failed to open failed`);
        });
      }
      throw error;
    }
    return new Promise((resolve) => {
      this.#entries.push({ id: ++this.#lastId, handler: window, focus: window, transient: true, resolve });
      this.#notify();
    });
  }

  /**
   * Closes the window `handler` is in: the one opened with `openTransient()` that is `handler` or its
   * nearest ancestor. It's disposed and removed from its opener, then the opener gets `result`.
   * Closing a window that's already closing does nothing.
   * @param {Handler} handler
   * @param {unknown} [result] JSON data.
   * @returns {Promise<void>} Settles once the window is disposed; a failure there is reported, not thrown.
   * @throws {Error} If `handler` is in no window, only in a lasting one, or `result` isn't JSON data.
   */
  async close(handler, result = null) {
    for (let node = /** @type {Handler | null} */ (handler); node; node = node.parent) {
      if (this.#closing.has(node)) {
        return;
      }
    }
    const entry = this.#entryOf(handler);
    if (!entry) {
      throw new Error(`Handler "${handler.path}" isn't in an open window`);
    }
    if (!entry.transient) {
      throw new Error(`Window "${entry.handler.path}" wasn't opened with openWindow(), so it can't be closed`);
    }
    const value = cloneData(result, [], { what: `Result of window "${entry.handler.path}"` });
    await this.#close(entry, value);
  }

  /**
   * Closes the top window with `null`, if it was opened with `openTransient()`.
   * @returns {Promise<boolean>} Whether there was such a window.
   */
  async closeTop() {
    const entry = this.#entries.at(-1);
    if (!entry?.transient) {
      return false;
    }
    await this.#close(entry, null);
    return true;
  }

  /**
   * Focuses `handler` within its window. If the window is covered, the focus takes effect once it's on top.
   * @param {Handler} handler
   * @throws {Error} If `handler` isn't in an open window.
   */
  focus(handler) {
    const entry = this.#entryOf(handler);
    if (!entry) {
      throw new Error(`Handler "${handler.path}" isn't in an open window, so it can't take the focus`);
    }
    if (entry.focus !== handler) {
      entry.focus = handler;
      this.#notify();
    }
  }

  /**
   * Called as each handler is disposed: its window closes with `null`, and a focus on it moves to its
   * parent. Sub-handlers are disposed before their parents, so the focus climbs out of a disposed subtree.
   * @param {Handler} handler
   */
  forget(handler) {
    let changed = false;
    for (const entry of [...this.#entries]) {
      if (entry.handler === handler) {
        this.#entries.splice(this.#entries.indexOf(entry), 1);
        entry.resolve(null);
        changed = true;
      } else if (entry.focus === handler) {
        entry.focus = handler.parent && isWithin(handler.parent, entry.handler) ? handler.parent : entry.handler;
        changed = true;
      }
    }
    if (changed) {
      this.#notify();
    }
  }

  /**
   * Calls `listener` whenever the windows or a focus change.
   * @param {() => void} listener
   * @returns {() => void} Unsubscribes.
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The innermost window `handler` is in.
   * @param {Handler} handler
   * @returns {Entry | undefined}
   */
  #entryOf(handler) {
    for (let node = /** @type {Handler | null} */ (handler); node; node = node.parent) {
      const entry = this.#entries.find((candidate) => candidate.handler === node);
      if (entry) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * @param {Entry} entry
   * @param {Data} result
   */
  async #close(entry, result) {
    const { handler } = entry;
    const { path } = handler;
    this.#closing.add(handler);
    this.#entries.splice(this.#entries.indexOf(entry), 1);
    this.#notify();
    try {
      // Disposing also closes the windows it opened (they're its sub-handlers), with null.
      await handler.parent?.remove(handler.name);
    } catch (error) {
      this.#report(error, `Disposing window "${path}" failed`);
    } finally {
      entry.resolve(result);
    }
  }

  #notify() {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

module.exports = { WindowStack };
