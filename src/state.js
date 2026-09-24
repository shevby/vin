const { log } = require('./log');

/**
 * JSON-compatible data — the only thing state can hold, so the same messages work in-process and over
 * JSON-RPC.
 * @typedef {null | boolean | number | string | Data[] | { [key: string]: Data }} Data
 */

/** @typedef {{ [key: string]: Data }} StateObject */

/**
 * One edit, addressed by the path of keys from the state root (array indices as strings).
 * @typedef {{ op: 'set', path: string[], value: Data } | { op: 'delete', path: string[] }} Patch
 */

/**
 * What a `Model` sends its subscribers: the whole state, or the edits since the last message.
 * @typedef {{ type: 'replace', state: StateObject } | { type: 'patch', patches: Patch[] }} StateMessage
 */

/** @typedef {(message: StateMessage) => void} StateListener */

/** Array methods that mutate in place; each is recorded as one `set` of the whole array. */
const MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

/**
 * Proxies handed out by any `Model`, mapped to the raw object behind them.
 * @type {WeakMap<object, object>}
 */
const proxyTargets = new WeakMap();

/**
 * @param {readonly string[]} path
 * @returns {string}
 */
function formatPath(path) {
  return path.length ? path.join('.') : '(root)';
}

/**
 * @param {unknown} value
 * @returns {value is object}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * Deep-copies `value`, checking that it's JSON data: `null`, booleans, strings, finite numbers, and plain
 * objects and dense arrays of those. State proxies are unwrapped.
 * @param {unknown} value
 * @param {string[]} [path] Where `value` sits, for error messages.
 * @param {{ what?: string, ancestors?: Set<object> }} [options] `what` names the value in errors (default
 *   `State`, e.g. `Event payload`); `ancestors` are the objects being copied above `value`, to detect cycles.
 * @returns {Data}
 * @throws {TypeError} If `value` holds anything else — `undefined`, functions, class instances, `Map`,
 *   `Date`, `NaN`, holes, cycles, or a `__proto__` key.
 */
function cloneData(value, path = [], { what = 'State', ancestors = new Set() } = {}) {
  if (isObject(value)) {
    value = proxyTargets.get(value) ?? value;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (!isObject(value)) {
    throw new TypeError(
      `${what} value at "${formatPath(path)}" is ${String(value)}; only JSON data is allowed (use null, not undefined)`,
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${what} value at "${formatPath(path)}" is circular`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const copy = new Array(value.length);
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          throw new TypeError(`${what} array at "${formatPath(path)}" has a hole at ${i}`);
        }
        copy[i] = cloneData(value[i], [...path, String(i)], { what, ancestors });
      }
      return copy;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `${what} value at "${formatPath(path)}" is a ${proto?.constructor?.name ?? 'non-plain'} object; only plain objects and arrays are allowed`,
      );
    }
    /** @type {StateObject} */
    const copy = {};
    for (const key of Object.keys(value)) {
      checkKey(key, path, what);
      copy[key] = cloneData(/** @type {Record<string, unknown>} */ (value)[key], [...path, key], { what, ancestors });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Freezes JSON data all the way down, in place.
 * @template {Data} T
 * @param {T} value
 * @returns {T} `value`.
 */
function deepFreeze(value) {
  if (isObject(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {string} key
 * @param {readonly string[]} path
 * @param {string} [what]
 */
function checkKey(key, path, what = 'State') {
  if (key === '__proto__') {
    throw new TypeError(`${what} key "__proto__" at "${formatPath(path)}" is reserved`);
  }
}

/**
 * A handler's state: JSON data behind a deep proxy that records every edit as a path-based patch.
 * Edits made in the same tick reach subscribers as one message.
 *
 * Top-level properties are registered by `replace()`: assigning or deleting any other top-level property
 * throws. Nested objects and arrays accept new keys freely.
 *
 * Values are copied on the way in (so later changes to the original don't leak in, and state stays a tree)
 * and on the way out (so subscribers never share objects with the model).
 */
class Model {
  /** @type {StateObject} */
  #root = {};
  /**
   * The proxy last made for each raw object, and the path it was made for.
   * @type {WeakMap<object, { key: string, proxy: any }>}
   */
  #proxies = new WeakMap();
  /** @type {Patch[]} */
  #patches = [];
  #replaced = false;
  #scheduled = false;
  /** @type {Set<StateListener>} */
  #listeners = new Set();

  /**
   * The live, editable state. Reading gives proxies for nested objects; assigning, deleting, and array
   * methods like `push` are recorded.
   * @returns {StateObject}
   */
  get state() {
    return this.#proxy(this.#root, []);
  }

  /**
   * Replaces the whole state, registering its top-level properties. Subscribers get it as one `replace`
   * message, which supersedes edits from earlier in the same tick.
   * @param {StateObject} state
   * @throws {TypeError} If `state` isn't a plain object of JSON data.
   */
  replace(state) {
    const root = cloneData(state);
    if (!isObject(root) || Array.isArray(root)) {
      throw new TypeError('State must be a plain object');
    }
    this.#root = root;
    this.#patches = [];
    this.#replaced = true;
    this.#schedule();
  }

  /**
   * Adds a subscriber. Pending edits are delivered to existing subscribers first; then `listener` gets the
   * current state as a `replace` message, synchronously, followed by every later change.
   * @param {StateListener} listener
   * @returns {() => void} Unsubscribes.
   */
  subscribe(listener) {
    this.flush();
    this.#listeners.add(listener);
    listener({ type: 'replace', state: structuredClone(this.#root) });
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Removes every subscriber. */
  clear() {
    this.#listeners.clear();
  }

  /**
   * Sends the edits since the last message now, instead of at the end of the tick. A listener that throws
   * is logged and doesn't stop the others.
   */
  flush() {
    if (!this.#replaced && !this.#patches.length) {
      return;
    }
    /** @type {StateMessage} */
    const message = this.#replaced
      ? { type: 'replace', state: this.#root }
      : { type: 'patch', patches: this.#patches };
    this.#replaced = false;
    this.#patches = [];
    for (const listener of this.#listeners) {
      try {
        // A copy per listener, so one can't change what the next one sees.
        listener(structuredClone(message));
      } catch (error) {
        log.error('State listener failed:', error);
      }
    }
  }

  #schedule() {
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.flush();
      });
    }
  }

  /**
   * Queues a patch. Its value is copied only when the message is sent, so until then it may be the live
   * object — which is safe for objects, whose keys never shift, but not for arrays edited in place: an
   * earlier `rows.5.size` patch would point past the end once `rows` shrinks. So a whole-array patch
   * (`supersedes`) drops the pending patches at or under its path; it already carries their effect.
   * @param {Patch} patch
   * @param {boolean} [supersedes]
   */
  #record(patch, supersedes = false) {
    // A pending replace sends the whole state anyway; with no subscribers, the next one gets a snapshot.
    if (this.#replaced || !this.#listeners.size) {
      return;
    }
    if (supersedes) {
      const { path } = patch;
      this.#patches = this.#patches.filter(
        (pending) => pending.path.length < path.length || path.some((segment, i) => pending.path[i] !== segment),
      );
    }
    this.#patches.push(patch);
    this.#schedule();
  }

  /**
   * @param {object} target A raw object in the state tree.
   * @param {string[]} path Where it sits.
   * @returns {any}
   */
  #proxy(target, path) {
    const key = path.join('\0');
    const cached = this.#proxies.get(target);
    if (cached?.key === key) {
      return cached.proxy;
    }
    const proxy = new Proxy(target, this.#traps(path));
    proxyTargets.set(proxy, target);
    this.#proxies.set(target, { key, proxy });
    return proxy;
  }

  /**
   * Throws unless `target` is still at `path` — a proxy kept across a `replace()`, or for an array element
   * that has since moved or been removed, is stale.
   * @param {object} target
   * @param {string[]} path
   */
  #assertLive(target, path) {
    /** @type {unknown} */
    let node = this.#root;
    for (const segment of path) {
      node = isObject(node) && Object.hasOwn(node, segment) ? /** @type {any} */ (node)[segment] : undefined;
    }
    if (node !== target) {
      throw new Error(`Stale state reference "${formatPath(path)}": it was replaced or moved; read it again from state`);
    }
  }

  /**
   * @param {string[]} path
   * @returns {ProxyHandler<any>}
   */
  #traps(path) {
    return {
      get: (target, key) => {
        if (typeof key === 'symbol') {
          return Reflect.get(target, key);
        }
        if (Array.isArray(target) && MUTATORS.has(key)) {
          return this.#mutator(target, path, key);
        }
        const value = Reflect.get(target, key);
        return isObject(value) && Object.hasOwn(target, key) ? this.#proxy(value, [...path, key]) : value;
      },
      set: (target, key, value) => {
        if (typeof key === 'symbol') {
          throw new TypeError('State keys must be strings');
        }
        this.#assertLive(target, path);
        if (!path.length && !Object.hasOwn(target, key)) {
          throw new Error(`State property "${key}" isn't registered; top-level properties come from update()`);
        }
        checkKey(key, path);
        if (Array.isArray(target)) {
          return this.#setArrayItem(target, path, key, value);
        }
        const data = cloneData(value, [...path, key]);
        if (!isObject(data) && Object.hasOwn(target, key) && Object.is(target[key], data)) {
          return true;
        }
        target[key] = data;
        this.#record({ op: 'set', path: [...path, key], value: data });
        return true;
      },
      deleteProperty: (target, key) => {
        if (typeof key === 'symbol') {
          throw new TypeError('State keys must be strings');
        }
        this.#assertLive(target, path);
        if (!path.length) {
          throw new Error(`State property "${key}" can't be deleted; top-level properties come from update()`);
        }
        if (Array.isArray(target)) {
          throw new TypeError(`State array "${formatPath(path)}" can't have holes; use splice() to remove items`);
        }
        if (Object.hasOwn(target, key)) {
          delete target[key];
          this.#record({ op: 'delete', path: [...path, key] });
        }
        return true;
      },
      defineProperty: () => {
        throw new TypeError('State properties are set by assignment, not defineProperty');
      },
      setPrototypeOf: () => {
        throw new TypeError("State objects' prototypes can't be changed");
      },
      preventExtensions: () => {
        throw new TypeError("State objects can't be frozen or sealed");
      },
    };
  }

  /**
   * Writes an array index or `length`, refusing anything that would leave holes. Shortening via `length`
   * shifts nothing but removes items, so it's recorded like a mutator: one `set` of the whole array.
   * @param {Data[]} target
   * @param {string[]} path
   * @param {string} key
   * @param {unknown} value
   * @returns {true}
   */
  #setArrayItem(target, path, key, value) {
    if (key === 'length') {
      if (!Number.isInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > target.length) {
        throw new RangeError(`State array "${formatPath(path)}" can only be shortened through length`);
      }
      if (value !== target.length) {
        target.length = /** @type {number} */ (value);
        this.#record({ op: 'set', path, value: target }, true);
      }
      return true;
    }
    const index = /^(0|[1-9]\d*)$/.test(key) ? Number(key) : NaN;
    if (!(index <= target.length)) {
      throw new TypeError(
        `State array "${formatPath(path)}" takes only indices up to its length (${target.length}), not "${key}"`,
      );
    }
    const data = cloneData(value, [...path, key]);
    if (index < target.length && !isObject(data) && Object.is(target[index], data)) {
      return true;
    }
    target[index] = data;
    this.#record({ op: 'set', path: [...path, key], value: data });
    return true;
  }

  /**
   * An array method that mutates the raw array directly (copying any new elements in) and records the
   * result as one `set` of the whole array — `shift()` on 10,000 rows is one patch, not 10,000.
   * @param {Data[]} target
   * @param {string[]} path
   * @param {string} method
   * @returns {(...args: any[]) => unknown}
   */
  #mutator(target, path, method) {
    return (...args) => {
      this.#assertLive(target, path);
      const items = [...path, '*'];
      if (method === 'push' || method === 'unshift') {
        args = args.map((arg) => cloneData(arg, items));
      } else if (method === 'splice') {
        args = [...args.slice(0, 2), ...args.slice(2).map((arg) => cloneData(arg, items))];
      } else if (method === 'fill') {
        args = [cloneData(args[0], items), ...args.slice(1)];
      }
      const result = Reflect.apply(/** @type {Function} */ (Reflect.get(Array.prototype, method)), target, args);
      this.#record({ op: 'set', path, value: target }, true);
      // sort(), reverse(), fill() and copyWithin() return the array itself — hand back the proxy, not the raw
      // array, or edits through the result would go unrecorded.
      return result === target ? this.#proxy(target, path) : result;
    };
  }
}

module.exports = { Model, cloneData, deepFreeze };
