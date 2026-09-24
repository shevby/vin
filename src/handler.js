const { getHost } = require('./host');
const { isName } = require('./names');
const { Model } = require('./state');

/**
 * @typedef {import('./state').StateObject} StateObject
 * @typedef {import('./state').StateListener} StateListener
 * @typedef {import('./events').EventListener} EventListener
 * @typedef {import('./contributions').Contributes} Contributes
 */

/**
 * Base class for the handler behind one window. Handlers nest: each can hold named sub-handlers to any
 * depth, addressed by dotted path (`main.left`), and the UI calls a handler method by appending its name
 * (`main.left.navigate`).
 *
 * Callable methods are, by convention, every method a subclass defines except `_underscored` and
 * `#private` ones; `Handler`'s own methods (lifecycle, tree management) are never callable.
 *
 * Lifecycle: `init()` runs `onInit()` and then initializes sub-handlers in the order they were added;
 * `dispose()` disposes sub-handlers in reverse order and then runs `onDispose()`. Both are idempotent.
 *
 * State: `this.update(state)` replaces the window's whole state and registers its top-level properties;
 * `this.state.a.b = …` edits one property. Either way the UI's copy follows automatically.
 * Type a subclass's state with `@extends {Handler<{ cwd: string }>}`.
 *
 * Events: `this.emit('changed', payload)` publishes `<this path>.changed` to every handler listening with
 * `this.on('main.left.changed', listener)`; listening stops when the listener's handler is disposed.
 * Both need the handler's tree to be registered with `Vin`.
 *
 * Contributions: a class declares its commands, keybindings, and context-menu entries in
 * `static contributes`, registered while an instance is initialized. Commands are named after the handler's
 * `kind` — `static kind`, or else the handler's name — so every pane shares `pane.down`, which runs on the
 * focused one.
 * @template {StateObject} [S=StateObject]
 */
class Handler {
  /**
   * What this class's handlers are, for addressing their commands (`pane.down`); defaults to the handler's
   * name. Set it when a class has several instances (`left` and `right` are both `pane`) or its instances'
   * names vary.
   * @type {string | undefined}
   */
  static kind = undefined;

  /**
   * Commands, keybindings, and context-menu entries this class contributes; see `src/contributions.js`.
   * @type {Contributes | undefined}
   */
  static contributes = undefined;

  #model = new Model();
  /** @type {Handler | null} */
  #parent = null;
  /** @type {Map<string, Handler>} */
  #children = new Map();
  /** @type {Promise<void> | null} */
  #initializing = null;
  /** @type {Promise<void> | null} */
  #disposing = null;
  /**
   * Event subscriptions made through `on()`, released on dispose.
   * @type {Set<() => void>}
   */
  #subscriptions = new Set();
  /**
   * Undoes the host's `attach()` from `init()`.
   * @type {(() => void) | null}
   */
  #detach = null;

  /**
   * @param {string} name Unique among its siblings (or among `Vin`'s top-level handlers).
   * @throws {TypeError} If `name` isn't a letter followed by letters, digits, `-` or `_`.
   */
  constructor(name) {
    if (!isName(name)) {
      throw new TypeError(`Invalid handler name "${name}": use a letter, then letters, digits, "-" or "_"`);
    }
    /** @readonly */
    this.name = name;
  }

  /** The handler this one was added to, or `null` for a top-level handler. */
  get parent() {
    return this.#parent;
  }

  /**
   * Sub-handlers by name, in the order they were added.
   * @returns {ReadonlyMap<string, Handler>}
   */
  get children() {
    return this.#children;
  }

  /**
   * Dotted path from the top-level handler down to this one, e.g. `main.left`.
   * @returns {string}
   */
  get path() {
    return this.#parent ? `${this.#parent.path}.${this.name}` : this.name;
  }

  /**
   * What this handler is, for addressing its commands: its class's `static kind`, or else its name.
   * @returns {string}
   */
  get kind() {
    return /** @type {typeof Handler} */ (this.constructor).kind ?? this.name;
  }

  /**
   * The window's live state. Assigning, deleting, and array methods like `push` are sent to the UI, batched
   * per tick. Top-level properties must first be registered by `update()`; nested objects take new keys
   * freely. Only JSON data is allowed.
   * @returns {S}
   */
  get state() {
    return /** @type {S} */ (this.#model.state);
  }

  /**
   * Replaces the window's whole state and registers its top-level properties.
   * @param {S} state JSON data; it's copied, so later changes to the argument don't affect the state.
   * @throws {TypeError} If `state` isn't a plain object of JSON data.
   */
  update(state) {
    this.#model.replace(state);
  }

  /**
   * Follows this handler's state: `listener` gets the current state at once, then one message per tick
   * with any changes. Subscriptions end when the handler is disposed.
   * @param {StateListener} listener
   * @returns {() => void} Unsubscribes.
   */
  subscribeState(listener) {
    return this.#model.subscribe(listener);
  }

  /**
   * Emits an event named after this handler: `emit('changed')` on `main.left` publishes
   * `main.left.changed`. Listeners get it a microtask later.
   * @param {string} event A name (letters, digits, `-`, `_`; no dots).
   * @param {unknown} [payload] JSON data; listeners get a frozen copy.
   * @throws {Error} If `event` isn't a name, `payload` isn't JSON data, or this handler's tree isn't
   *   registered with `Vin`.
   */
  emit(event, payload = null) {
    if (!isName(event)) {
      throw new TypeError(`Invalid event name "${event}": use a letter, then letters, digits, "-" or "_"`);
    }
    this.#events('emit').emit(`${this.path}.${event}`, payload, this.path);
  }

  /**
   * Listens for an event by its full name, until this handler is disposed.
   * @param {string} name `<handler path>.<event>`, e.g. `main.left.changed`.
   * @param {EventListener} listener Called with the payload and `{ name, source }`.
   * @returns {() => void} Stops listening earlier.
   * @throws {Error} If `name` isn't valid, this handler is disposed, or its tree isn't registered with `Vin`.
   */
  on(name, listener) {
    if (this.#disposing) {
      throw new Error(`Disposed handler "${this.path}" can't listen for "${name}"`);
    }
    const off = this.#events('listen for').on(name, listener);
    this.#subscriptions.add(off);
    return () => {
      off();
      this.#subscriptions.delete(off);
    };
  }

  /**
   * @param {string} action For the error message.
   */
  #events(action) {
    const host = getHost(this);
    if (!host) {
      throw new Error(`Handler "${this.path}" can't ${action} events: its top-level handler isn't registered with Vin`);
    }
    return host.events;
  }

  /**
   * Adds a sub-handler. One added after this handler was initialized isn't initialized automatically —
   * use `await this.add(child).init()`.
   * @template {Handler} T
   * @param {T} child
   * @returns {T} `child`, for chaining.
   * @throws {Error} If `child` already has a parent, is this handler or one of its ancestors, or its name
   *   is taken, or this handler is disposed.
   */
  add(child) {
    if (!(child instanceof Handler)) {
      throw new TypeError(`Sub-handler of "${this.path}" must be a Handler`);
    }
    if (this.#disposing) {
      throw new Error(`Cannot add "${child.name}" to disposed handler "${this.path}"`);
    }
    if (child.#parent) {
      throw new Error(`Handler "${child.path}" already has a parent`);
    }
    for (let ancestor = /** @type {Handler | null} */ (this); ancestor; ancestor = ancestor.#parent) {
      if (ancestor === child) {
        throw new Error(`Cannot add "${child.name}" to its own sub-handler "${this.path}"`);
      }
    }
    if (this.#children.has(child.name)) {
      throw new Error(`Handler "${this.path}" already has a sub-handler named "${child.name}"`);
    }
    child.#parent = this;
    this.#children.set(child.name, child);
    return child;
  }

  /**
   * Detaches a sub-handler and disposes it.
   * @param {string} name
   * @returns {Promise<void>}
   * @throws {Error} If there's no sub-handler with that name, or disposing it fails.
   */
  async remove(name) {
    const child = this.#children.get(name);
    if (!child) {
      throw new Error(`Handler "${this.path}" has no sub-handler named "${name}"`);
    }
    // Unreachable by path at once, but still attached while disposing, so onDispose() sees its parent.
    this.#children.delete(name);
    try {
      await child.dispose();
    } finally {
      child.#parent = null;
    }
  }

  /**
   * Finds a descendant by a dotted path relative to this handler (`left`, `left.preview`).
   * @param {string} path
   * @returns {Handler}
   * @throws {Error} If any segment of the path doesn't exist.
   */
  resolve(path) {
    /** @type {Handler} */
    let handler = this;
    for (const segment of path.split('.')) {
      const next = handler.#children.get(segment);
      if (!next) {
        throw new Error(`No handler "${handler.path}.${segment}"`);
      }
      handler = next;
    }
    return handler;
  }

  /**
   * Calls a method by a dotted path relative to this handler: the last segment is the method, the rest
   * the sub-handler it's called on (`navigate`, `left.navigate`).
   * @param {string} path
   * @param {...unknown} args
   * @returns {Promise<unknown>} The method's result, awaited — calls are always async, so they look the same
   *   whether the UI runs in this process or talks to it over JSON-RPC.
   * @throws {Error} If the handler doesn't exist or is disposed, or the method isn't callable.
   */
  async call(path, ...args) {
    const dot = path.lastIndexOf('.');
    const target = dot < 0 ? this : this.resolve(path.slice(0, dot));
    const method = path.slice(dot + 1);
    if (!Handler.isCallable(target, method)) {
      throw new Error(`Handler "${target.path}" has no callable method "${method}"`);
    }
    if (target.#disposing) {
      throw new Error(`Handler "${target.path}" is disposed`);
    }
    const fn = /** @type {(...args: unknown[]) => unknown} */ (Reflect.get(target, method));
    return await fn.apply(target, args);
  }

  /**
   * Whether `method` can be called on `handler` by path: a method defined by a `Handler` subclass,
   * not starting with `_`. Fields, getters, and `Handler`'s own methods don't count.
   * @param {Handler} handler
   * @param {string} method
   * @returns {boolean}
   */
  static isCallable(handler, method) {
    if (!method || method.startsWith('_') || method in Handler.prototype) {
      return false;
    }
    for (
      let proto = Object.getPrototypeOf(handler);
      proto && proto !== Handler.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, method);
      if (descriptor) {
        return typeof descriptor.value === 'function';
      }
    }
    return false;
  }

  /**
   * Runs `onInit()`, then initializes sub-handlers in the order they were added (including ones added
   * during `onInit()`). Calling it again returns the same promise.
   * @returns {Promise<void>}
   */
  init() {
    this.#initializing ??= this.#runInit();
    return this.#initializing;
  }

  async #runInit() {
    if (this.#disposing) {
      throw new Error(`Cannot initialize disposed handler "${this.path}"`);
    }
    // Registers the class's contributions (for the first handler of its kind), so they exist during onInit().
    this.#detach = getHost(this)?.attach(this) ?? null;
    await this.onInit();
    for (const child of this.#children.values()) {
      await child.init();
    }
  }

  /**
   * Disposes sub-handlers in reverse order, then runs `onDispose()` — only if `init()` was called, and
   * after it settles. Every step runs even if an earlier one fails. Calling it again returns the same promise.
   * @returns {Promise<void>}
   * @throws {Error | AggregateError} The failure, or all of them if more than one step failed.
   */
  dispose() {
    this.#disposing ??= this.#runDispose();
    return this.#disposing;
  }

  async #runDispose() {
    /** @type {unknown[]} */
    const errors = [];
    // Never run onDispose() alongside a pending onInit(); an init failure was already reported to its caller.
    const initializing = this.#initializing?.catch(() => {});
    await initializing;
    for (const child of [...this.#children.values()].reverse()) {
      await child.dispose().catch((error) => errors.push(error));
    }
    if (initializing) {
      await Promise.resolve()
        .then(() => this.onDispose())
        .catch((error) => errors.push(error));
    }
    for (const off of this.#subscriptions) {
      off();
    }
    this.#subscriptions.clear();
    this.#detach?.();
    this.#detach = null;
    this.#model.flush();
    this.#model.clear();
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `Disposing handler "${this.path}" failed`);
    }
  }

  /**
   * Override to set the handler up; runs once, before its sub-handlers are initialized.
   * @protected
   * @returns {Promise<void> | void}
   */
  onInit() {}

  /**
   * Override to release what `onInit()` acquired; runs once, after its sub-handlers are disposed.
   * @protected
   * @returns {Promise<void> | void}
   */
  onDispose() {}
}

module.exports = Handler;
