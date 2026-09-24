/**
 * A keybinding that could fire for the current focus.
 * @typedef {object} Candidate
 * @property {readonly string[]} keys Its chords, e.g. `['g', 'g']`.
 * @property {number} depth How near the focus its target is; only the deepest matches count, so a
 *   window's bindings shadow those of the windows around it.
 * @property {() => void} run
 */

/**
 * Matches key presses against multi-key bindings, vim-style:
 * - a sequence that is a complete binding and the prefix of none fires at once;
 * - a sequence that is the prefix of a longer binding waits for the next key, up to `timeout` ms, then fires
 *   the complete binding it is, if any (`g` bound, `g g` bound: `g` fires after the timeout);
 * - a key that continues no binding drops the pending keys and starts over with that key alone;
 * - among equally deep bindings with the same keys, the last one wins, so user bindings, added last,
 *   override defaults.
 */
class KeySequencer {
  /** @type {(focus: string | null) => Candidate[]} */
  #candidates;
  #timeout;
  /** @type {(pending: readonly string[]) => void} */
  #onPending;
  /** @type {string[]} */
  #pending = [];
  /** @type {string | null} */
  #focus = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  #timer = null;

  /**
   * @param {object} options
   * @param {(focus: string | null) => Candidate[]} options.candidates The bindings active for `focus`,
   *   asked on every key.
   * @param {number} [options.timeout] How long to wait for the rest of a sequence, in ms. Default 1000,
   *   like vifm's `timeoutlen`.
   * @param {(pending: readonly string[]) => void} [options.onPending] Called when the pending keys change,
   *   e.g. to show them.
   */
  constructor({ candidates, timeout = 1000, onPending = () => {} }) {
    this.#candidates = candidates;
    this.#timeout = timeout;
    this.#onPending = onPending;
  }

  /**
   * Keys pressed so far toward a longer binding.
   * @returns {readonly string[]}
   */
  get pending() {
    return this.#pending;
  }

  /**
   * Handles one key press.
   * @param {string} chord A canonical chord (`src/keys.js`).
   * @param {string | null} focus Path of the focused handler.
   * @returns {boolean} Whether a binding used the key (fired or is waiting for more).
   */
  press(chord, focus) {
    this.#clearTimer();
    if (this.#pending.length && focus !== this.#focus) {
      this.#setPending([]);
    }
    const sequence = [...this.#pending, chord];
    const match = this.#match(sequence, focus);
    if (!match) {
      const hadPending = this.#pending.length > 0;
      this.#setPending([]);
      return hadPending ? this.press(chord, focus) : false;
    }
    const { complete, longer } = match;
    if (complete && !longer) {
      this.#setPending([]);
      complete.run();
      return true;
    }
    this.#focus = focus;
    this.#setPending(sequence);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#setPending([]);
      complete?.run();
    }, this.#timeout);
    this.#timer.unref?.();
    return true;
  }

  /** Drops any pending keys without firing. */
  reset() {
    this.#clearTimer();
    this.#setPending([]);
  }

  /**
   * @param {readonly string[]} sequence
   * @param {string | null} focus
   * @returns {{ complete: Candidate | null, longer: boolean } | null} `null` if no binding starts with it.
   */
  #match(sequence, focus) {
    const matching = this.#candidates(focus).filter(
      (candidate) => candidate.keys.length >= sequence.length && sequence.every((chord, i) => candidate.keys[i] === chord),
    );
    if (!matching.length) {
      return null;
    }
    const depth = Math.max(...matching.map((candidate) => candidate.depth));
    const deepest = matching.filter((candidate) => candidate.depth === depth);
    return {
      complete: deepest.findLast((candidate) => candidate.keys.length === sequence.length) ?? null,
      longer: deepest.some((candidate) => candidate.keys.length > sequence.length),
    };
  }

  /** @param {string[]} pending */
  #setPending(pending) {
    if (pending.length || this.#pending.length) {
      this.#pending = pending;
      this.#onPending(pending);
    }
  }

  #clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

module.exports = { KeySequencer };
