const { describeError, isExpected } = require('./errors');
const { log: defaultLog } = require('./log');
const { paths: defaultPaths } = require('./paths');

/**
 * @typedef {'error' | 'warning' | 'info'} MessageLevel
 * @typedef {import('./log').Logger} Logger
 */

/**
 * One message the UI shows, as `core` has it in `state.messages`.
 * @typedef {object} Message
 * @property {number} id Increasing; a repeat of the last message takes a new one, so `clear(upTo)` leaves it.
 * @property {MessageLevel} level
 * @property {string} text For the user; may hold line breaks.
 * @property {number} count How many times it came in a row (`Permission denied: ~/x (×3)`).
 */

/**
 * Where code that can't throw to anyone sends a failure: `context` says what failed, for the log.
 * @typedef {(error: unknown, context: string) => void} ErrorReporter
 */

/** @type {readonly MessageLevel[]} */
const LEVELS = ['error', 'warning', 'info'];

/** Most messages kept at once — the oldest go first, if something keeps failing before anyone looks. */
const LIMIT = 50;

/**
 * The messages the UI shows now: each stays until the user has seen it — the next key press clears them
 * (`core.press`), or a key dismissing the popup that shows several (`core.clearMessages`). How they're
 * shown is the UI's choice: the TUI puts one short message on the bottom line, and more in a popup.
 */
class Messages {
  /** @type {Message[]} */
  #messages = [];
  #nextId = 1;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {InstanceType<typeof import('./paths').Paths>} */
  #paths;
  /** @type {Logger} */
  #log;

  /**
   * @param {object} [options]
   * @param {InstanceType<typeof import('./paths').Paths>} [options.paths] Shows paths in messages.
   * @param {Logger} [options.log] Where unexpected errors go. Default: vin's log (`src/log.js`).
   */
  constructor({ paths = defaultPaths, log = defaultLog } = {}) {
    this.#paths = paths;
    this.#log = log;
  }

  /**
   * The messages shown now, oldest first — copies.
   * @returns {Message[]}
   */
  get list() {
    return this.#messages.map((message) => ({ ...message }));
  }

  /**
   * Shows a message. The same text at the same level as the last one counts up instead of repeating.
   * @param {string} text
   * @param {MessageLevel} [level] Default: `info`.
   * @throws {TypeError} If `text` isn't a non-empty string or `level` isn't a level.
   */
  show(text, level = 'info') {
    if (typeof text !== 'string' || !text) {
      throw new TypeError('A message must be a non-empty string');
    }
    if (!LEVELS.includes(level)) {
      throw new TypeError(`Invalid message level "${level}": use ${LEVELS.join(', ')}`);
    }
    const last = this.#messages.at(-1);
    if (last?.text === text && last.level === level) {
      last.count++;
      last.id = this.#nextId++;
    } else {
      this.#messages.push({ id: this.#nextId++, level, text, count: 1 });
      this.#messages.splice(0, this.#messages.length - LIMIT);
    }
    this.#notify();
  }

  /**
   * Shows a failure as an error message. An expected one (`src/errors.js`) is described for the user and
   * only debug-logged; anything else is a bug, logged with its stack and shown as unexpected, pointing to
   * the log.
   * @param {unknown} error
   * @param {string} [context] What failed, for the log: `Keybinding "j" → pane.down on "main.left" failed`.
   */
  report(error, context = 'An operation failed') {
    const text = describeError(error, this.#paths);
    if (isExpected(error)) {
      this.#log.debug(`${context}:`, error);
      this.show(text, 'error');
      return;
    }
    this.#log.error(`${context}:`, error);
    const file = this.#log.file;
    this.show(`Unexpected error: ${text}${file ? ` — details in ${this.#paths.display(file)}` : ''}`, 'error');
  }

  /**
   * Clears the messages the user has seen.
   * @param {number | null} [upTo] The last one seen, by `id`; later ones stay. Default: all of them.
   */
  clear(upTo = null) {
    const count = this.#messages.length;
    this.#messages = upTo === null ? [] : this.#messages.filter((message) => message.id > upTo);
    if (this.#messages.length !== count) {
      this.#notify();
    }
  }

  /**
   * @param {() => void} listener Called after every change; read `list` for the messages.
   * @returns {() => void} Unsubscribes.
   */
  subscribe(listener) {
    const subscription = () => listener();
    this.#listeners.add(subscription);
    return () => this.#listeners.delete(subscription);
  }

  #notify() {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#log.error('Messages listener failed:', error);
      }
    }
  }
}

/**
 * Reports every uncaught exception and unhandled rejection instead of letting it end the process — so a
 * bug in one command doesn't cost the session. For while the UI runs (`Vin#start`).
 * @param {InstanceType<typeof Messages>} messages
 * @param {Pick<NodeJS.EventEmitter, 'on' | 'off'>} [target] Where they're emitted. Default: `process`.
 * @returns {() => void} Stops catching them.
 */
function catchUncaught(messages, target = process) {
  /** @param {string} context */
  const reporter = (context) => (/** @type {unknown} */ error) => {
    try {
      messages.report(error, context);
    } catch {
      // Nothing is left to tell; never throw from here, which would end the process after all.
    }
  };
  const exception = reporter('Uncaught exception');
  const rejection = reporter('Unhandled rejection');
  target.on('uncaughtException', exception);
  target.on('unhandledRejection', rejection);
  return () => {
    target.off('uncaughtException', exception);
    target.off('unhandledRejection', rejection);
  };
}

module.exports = { Messages, catchUncaught, LEVELS };
