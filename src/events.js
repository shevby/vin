const { log } = require('./log');
const { isPath } = require('./names');
const { cloneData, deepFreeze } = require('./state');

/** @typedef {import('./state').Data} Data */

/**
 * @typedef {object} EventInfo
 * @property {string} name The full event name, e.g. `main.left.changed`.
 * @property {string} source The path of the handler that emitted it, e.g. `main.left`.
 */

/**
 * @typedef {(payload: Data, event: EventInfo) => unknown} EventListener
 */

/**
 * The bus for events between handlers (and later plugins). An event's name is its source's path plus a
 * name (`main.left.changed`), so names never collide and no handler can emit on another's behalf —
 * `Handler#emit` adds the prefix.
 *
 * Delivery is asynchronous (a microtask after `emit`), as it will be for a plugin over JSON-RPC, so a
 * listener never runs inside the emitter's code. Payloads are JSON data, copied at `emit` and deep-frozen,
 * so every listener sees the same value and none can change it for the others.
 */
class EventBus {
  /** @type {Map<string, Set<EventListener>>} */
  #listeners = new Map();
  /** @type {import('./messages').ErrorReporter} */
  #report;

  /**
   * @param {object} [options]
   * @param {import('./messages').ErrorReporter} [options.report] Gets a listener's failure. Default: logs it.
   */
  constructor({ report = (error, context) => log.error(`${context}:`, error) } = {}) {
    this.#report = report;
  }

  /**
   * Listens for an event by its full name.
   * @param {string} name `<handler path>.<event>`, e.g. `main.left.changed`.
   * @param {EventListener} listener Called with the payload and `{ name, source }`. One that throws or
   *   rejects is reported and doesn't stop the others.
   * @returns {() => void} Stops listening.
   * @throws {TypeError} If `name` isn't a handler path followed by an event name.
   */
  on(name, listener) {
    if (!isPath(name, 2)) {
      throw new TypeError(`Invalid event name "${name}": expected "<handler path>.<event>", e.g. "main.left.changed"`);
    }
    if (typeof listener !== 'function') {
      throw new TypeError(`Listener for "${name}" must be a function`);
    }
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(name, listeners);
    }
    // A wrapper, so the same function can listen twice and each `off` removes only its own subscription.
    /** @type {EventListener} */
    const subscription = (payload, event) => listener(payload, event);
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
      if (!listeners.size && this.#listeners.get(name) === listeners) {
        this.#listeners.delete(name);
      }
    };
  }

  /**
   * Emits an event. Listeners subscribed when it's delivered — a microtask later — get it.
   * Use `Handler#emit`, which names the event after the handler; this is the low-level entry point.
   * @param {string} name The full name, `<source>.<event>`.
   * @param {unknown} payload JSON data.
   * @param {string} source The emitting handler's path.
   * @throws {TypeError} If `name` isn't valid or `payload` isn't JSON data.
   */
  emit(name, payload, source) {
    if (!isPath(name, 2)) {
      throw new TypeError(`Invalid event name "${name}"`);
    }
    const data = deepFreeze(cloneData(payload, [], { what: `Event "${name}" payload` }));
    /** @type {EventInfo} */
    const event = Object.freeze({ name, source });
    queueMicrotask(() => {
      const listeners = this.#listeners.get(name) ?? new Set();
      // Ones added during delivery wait for the next event; ones removed during it are skipped.
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) {
          continue;
        }
        try {
          const result = listener(data, event);
          if (result instanceof Promise) {
            result.catch((error) => this.#report(error, `Listener for event "${name}" failed`));
          }
        } catch (error) {
          this.#report(error, `Listener for event "${name}" failed`);
        }
      }
    });
  }
}

module.exports = { EventBus };
