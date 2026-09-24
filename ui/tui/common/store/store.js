/**
 * @typedef {import('../../../../src/state.js').StateObject} StateObject
 * @typedef {import('../../../../src/state.js').StateMessage} StateMessage
 * @typedef {import('../../../../src/state.js').Patch} Patch
 */

/**
 * The UI's mirror of one handler's state. It applies the handler's messages immutably, so every change
 * makes a new snapshot that shares untouched subtrees with the previous one — which is what lets
 * `useSelector` skip components whose slice didn't change.
 * @typedef {object} Store
 * @property {() => StateObject} getSnapshot The current state; never mutated, replaced on every change.
 * @property {(listener: () => void) => () => void} subscribe Calls `listener` after each change; returns an
 *   unsubscribe function.
 * @property {(message: StateMessage) => void} apply Applies a message from the handler (see
 *   `Handler#subscribeState`), then notifies subscribers once.
 */

/**
 * Creates an empty store. Nothing about the state's shape is declared here — it's whatever the handler
 * sends.
 * @returns {Store}
 */
export function createStore() {
  /** @type {StateObject} */
  let state = {};
  /** @type {Set<() => void>} */
  const listeners = new Set();

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply(message) {
      state = message.type === 'replace' ? message.state : applyPatches(state, message.patches);
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

/**
 * Applies patches without mutating `state`: every object on a patched path is copied (once per call),
 * everything else is shared with `state`.
 * @param {StateObject} state
 * @param {readonly Patch[]} patches
 * @returns {StateObject}
 * @throws {Error} If a patch goes through something that isn't an object — the mirror is out of sync.
 */
export function applyPatches(state, patches) {
  /** Copies made during this call, which are safe to mutate. */
  const copies = new WeakSet();
  /** @type {(node: any) => any} */
  const copy = (node) => {
    if (copies.has(node)) {
      return node;
    }
    const result = Array.isArray(node) ? node.slice() : { ...node };
    copies.add(result);
    return result;
  };

  const root = copy(state);
  for (const patch of patches) {
    const { path } = patch;
    let node = root;
    for (let i = 0; i < path.length - 1; i++) {
      const child = node[path[i]];
      if (typeof child !== 'object' || child === null) {
        throw new Error(`Can't apply patch at "${path.join('.')}": "${path.slice(0, i + 1).join('.')}" isn't an object`);
      }
      node = node[path[i]] = copy(child);
    }
    const key = path[path.length - 1];
    if (patch.op === 'set') {
      node[key] = patch.value;
    } else {
      delete node[key];
    }
  }
  return root;
}
