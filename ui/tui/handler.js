import { log } from '../../src/log.js';
import { createStore } from './common/store/index.js';

/**
 * @typedef {import('../../src/transport.js').Transport} Transport
 * @typedef {import('./common/store/store.js').Store} Store
 */

/**
 * The UI's handle on a backend handler, from `init()`. Chaining names walks down the handler tree and
 * calling one calls that method: `main.left.navigate('/tmp')` calls `navigate` on `main.left` and returns a
 * promise of its result. Arguments and results are JSON data.
 *
 * Three names are the handle's own, so a sub-handler or method with one of them is reached through
 * `init('main.store')` instead:
 * - `store` — the handler's state mirror, for `useSelector(main.left.store, (state) => state.cwd)`;
 * - `path` — the dotted path (`main.left`);
 * - `then` — always `undefined`, so a handle is never mistaken for a promise.
 * @typedef {((...args: any[]) => Promise<any>) & { readonly store: Store, readonly path: string, readonly [name: string]: any }} Handle
 */

/** @type {Transport | null} */
let transport = null;
/** @type {Map<string, Handle>} */
const handles = new Map();
/**
 * One store per handler path, shared by every handle and component that reads it.
 * @type {Map<string, { store: Store, unsubscribe: () => void }>}
 */
const connections = new Map();

/**
 * Connects the UI to the backend; `init()` handles work from now on. Replaces any earlier connection.
 * @param {Transport} next
 */
export function connect(next) {
  disconnect();
  transport = next;
}

/** Stops following every handler's state and forgets the transport. */
export function disconnect() {
  for (const connection of connections.values()) {
    connection.unsubscribe();
  }
  connections.clear();
  transport = null;
}

/**
 * Stops following the state of a handler and of everything under it (`main.left.confirm` and
 * `main.left.confirm.*`) and drops their stores — for a window that closed, whose handlers are gone. A
 * handler opened again at the same path gets a fresh store the next time `store` is read.
 * @param {string} path
 */
export function release(path) {
  for (const [key, connection] of connections) {
    if (key === path || key.startsWith(`${path}.`)) {
      connection.unsubscribe();
      connections.delete(key);
    }
  }
}

/**
 * The handle for a backend handler, by its full dotted path (`main`, `main.left`). Handles are cheap and
 * cached, so calling `init()` at module level or in a component is fine; nothing reaches the backend until
 * a method is called or `store` is read.
 * @param {string} path
 * @returns {Handle}
 */
export function init(path) {
  let handle = handles.get(path);
  if (!handle) {
    handle = createHandle(path);
    handles.set(path, handle);
  }
  return handle;
}

/**
 * @param {string} path
 * @returns {Handle}
 */
function createHandle(path) {
  // A function, so the proxy can be called; an arrow function, so it has no `prototype` to trip over.
  const target = () => {};
  return /** @type {Handle} */ (
    new Proxy(target, {
      get(target, key) {
        if (key === 'store') {
          return storeFor(path);
        }
        if (key === 'path') {
          return path;
        }
        if (key === 'then') {
          return undefined;
        }
        // Symbols (`Symbol.toPrimitive`, `util.inspect.custom`) and `Object.prototype` names like `toString`
        // behave as usual; they're never callable handler methods anyway.
        if (typeof key === 'symbol' || key in Object.prototype) {
          return Reflect.get(target, key);
        }
        return init(`${path}.${key}`);
      },
      apply(_target, _this, args) {
        return connected().call(path, args);
      },
    })
  );
}

/** @returns {Transport} */
function connected() {
  if (!transport) {
    throw new Error('The UI is not connected to the backend; call connect() first');
  }
  return transport;
}

/**
 * The store mirroring a handler's state, following it from the first time it's asked for until `release()`
 * or `disconnect()`.
 * @param {string} path
 * @returns {Store}
 */
function storeFor(path) {
  let connection = connections.get(path);
  if (!connection) {
    connection = { store: createStore(), unsubscribe: () => {} };
    connections.set(path, connection);
    try {
      follow(path, connection);
    } catch (error) {
      connections.delete(path);
      throw error;
    }
  }
  return connection.store;
}

/**
 * Subscribes a store to its handler. If a message can't be applied, the mirror is out of sync — which is a
 * bug, but shouldn't leave the window showing stale state — so it's logged and the store subscribes again,
 * which starts over from a fresh snapshot.
 * @param {string} path
 * @param {{ store: Store, unsubscribe: () => void }} connection
 */
function follow(path, connection) {
  connection.unsubscribe = connected().subscribe(path, (message) => {
    try {
      connection.store.apply(message);
    } catch (error) {
      log.error(`State of "${path}" is out of sync; resubscribing:`, error);
      connection.unsubscribe();
      // Not from inside the listener: the backend is still delivering this message.
      queueMicrotask(() => {
        if (connections.get(path) === connection) {
          follow(path, connection);
        }
      });
    }
  });
}
