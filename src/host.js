/**
 * @typedef {InstanceType<typeof import('./events').EventBus>} EventBus
 * @typedef {InstanceType<typeof import('./handler')>} Handler
 * @typedef {InstanceType<typeof import('./windows').WindowStack>} WindowStack
 */

/**
 * What a registered handler tree gets from `Vin`. It's set on the top-level handler only; sub-handlers
 * reach it through their root, so moving a handler between trees needs no bookkeeping.
 * @typedef {object} Host
 * @property {EventBus} events
 * @property {WindowStack} windows
 * @property {(handler: Handler) => () => void} attach Called when a handler of the tree is initialized; returns
 *   what to call when it is disposed.
 */

/** @type {WeakMap<Handler, Host>} */
const hosts = new WeakMap();

/**
 * Attaches a top-level handler (and so its whole tree) to a host.
 * @param {Handler} handler
 * @param {Host} host
 */
function setHost(handler, host) {
  hosts.set(handler, host);
}

/**
 * The host of the tree `handler` belongs to, or `undefined` if its top-level handler isn't registered.
 * @param {Handler} handler
 * @returns {Host | undefined}
 */
function getHost(handler) {
  let root = handler;
  while (root.parent) {
    root = root.parent;
  }
  return hosts.get(root);
}

module.exports = { setHost, getHost };
