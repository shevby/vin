const { cloneData } = require('./state');

/**
 * @typedef {import('./state').Data} Data
 * @typedef {import('./state').StateListener} StateListener
 * @typedef {import('./vin')} Vin
 */

/**
 * How the UI reaches the backend: the same two operations, with the same JSON messages, whether the UI runs
 * in this process (`createInProcessTransport`) or talks to it over JSON-RPC.
 * @typedef {object} Transport
 * @property {(path: string, args: Data[]) => Promise<Data>} call Calls a handler method by its full dotted
 *   path (`main.left.navigate`). Resolves with its result (`null` for none); rejects with a `CallError`.
 * @property {(handler: string, listener: StateListener) => () => void} subscribe Follows a handler's state
 *   (`main.left`): `listener` gets a `replace` message with the whole state, then one message per tick with
 *   any changes. Returns an unsubscribe function.
 */

/**
 * A failed call. Only what survives JSON-RPC is kept on it — the message and a string `code` such as
 * `ENOENT` — so code handling it works the same in-process; the original error stays on `cause`, for the
 * log.
 * @typedef {Error & { code?: string }} CallError
 */

/**
 * A transport that calls straight into `vin`, for a UI in the same process (the TUI). Arguments and results
 * are still checked and copied as JSON, and errors reduced to a `CallError`, so nothing works here that
 * would break over JSON-RPC.
 * @param {Vin} vin
 * @returns {Transport}
 */
function createInProcessTransport(vin) {
  return {
    async call(path, args) {
      const what = `"${path}"`;
      const copied = /** @type {Data[]} */ (cloneData(args, ['args'], { what }));
      let result;
      try {
        result = await vin.call(path, ...copied);
      } catch (error) {
        throw toCallError(error);
      }
      return result === undefined ? null : cloneData(result, ['result'], { what });
    },
    subscribe(handler, listener) {
      return vin.resolve(handler).subscribeState(listener);
    },
  };
}

/**
 * @param {unknown} error
 * @returns {CallError}
 */
function toCallError(error) {
  /** @type {CallError} */
  const result = new Error(error instanceof Error ? error.message : String(error), { cause: error });
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  if (typeof code === 'string') {
    result.code = code;
  }
  return result;
}

module.exports = { createInProcessTransport };
