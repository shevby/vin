const Handler = require('../../handler');
const { chordText, isChord } = require('../../keys');
const { KeySequencer } = require('../../keymap');

/**
 * @typedef {import('../../state').Data} Data
 * @typedef {InstanceType<typeof import('../../contributions').Registry>} Registry
 * @typedef {InstanceType<typeof import('../../windows').WindowStack>} WindowStack
 * @typedef {import('../../windows').WindowInfo} WindowInfo
 * @typedef {InstanceType<typeof import('../../messages').Messages>} Messages
 * @typedef {import('../../messages').Message} Message
 * @typedef {import('../../colors').Style} Style
 */

/**
 * The built-in `core` handler: vin's own API for the UI, beyond any one window.
 * - Its state mirrors the contribution registry — `contributions.commands`, `contributions.keybindings`, … —
 *   so the UI reads them like any other state.
 * - `windows` lists the open windows, bottom to top, each with its focus; the UI draws them in that order,
 *   and the top one's focus gets the keys.
 * - It runs commands (`execute`) and resolves key presses into them (`press`) for the focus; `pendingKeys`
 *   shows a sequence in progress (`g` while waiting for `g g`). A command run by a key that fails is
 *   reported.
 * - `messages` lists the messages to show (`src/messages.js`), until the next key press clears them.
 * - `colors` is the color scheme (`src/colors.js`): every declared group's style, by id, with the user's
 *   changes. It declares the groups every window shares; the rest come from the kinds that draw them.
 * - `quitting` turns `true` when vin should exit (`quit`); the UI then closes, and `Vin#start` disposes
 *   the handlers.
 * @extends {Handler<{ contributions: { [point: string]: Data[] }, windows: WindowInfo[], pendingKeys: string, messages: Message[], colors: { [id: string]: Style }, quitting: boolean }>}
 */
class Core extends Handler {
  static kind = 'core';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'closeWindow', title: 'Close window', description: 'Closes the window on top, unless it is the main window' },
      { method: 'quit', title: 'Quit', description: 'Exits vin' },
    ],
    keybindings: [
      { key: 'escape', command: 'core.closeWindow' },
      // Until the command line (6) brings :q.
      { key: 'z z', command: 'core.quit' },
    ],
    configuration: [
      {
        key: 'keyTimeout',
        type: 'integer',
        default: 1000,
        minimum: 0,
        description: 'How long a key sequence (g g) waits for its next key, in ms.',
      },
    ],
    // papercolor-dark, from vifm-colors; each notes the vifm group it comes from.
    colors: [
      { key: 'window', default: { fg: 252, bg: 234 }, description: 'Text and background of every window (vifm: Win).' },
      { key: 'border', default: { fg: 252 }, description: 'Borders of windows and panes (vifm: Border).' },
      { key: 'title', default: { fg: 71, bold: true }, description: 'Dialog titles (vifm: TopLine).' },
      { key: 'highlight', default: { bold: true, inverse: true }, description: 'The highlighted button or choice (vifm: CurrLine).' },
      { key: 'hotkey', default: { fg: 74 }, description: "A choice's own key, in choice lists." },
      { key: 'hint', default: { fg: 244 }, description: 'Secondary text: descriptions, "Press any key" (vifm: LineNr).' },
      { key: 'cursor', default: { inverse: true }, description: 'The cursor in a text field.' },
      { key: 'error', default: { fg: 160, bold: true }, description: 'Error messages (vifm: ErrorMsg).' },
      { key: 'warning', default: { fg: 173, bold: true }, description: 'Warnings.' },
      { key: 'info', default: { fg: 252 }, description: 'Other messages (vifm: CmdLine).' },
    ],
  };

  /** @type {Registry} */
  #registry;
  /** @type {WindowStack} */
  #windows;
  /** @type {(() => void)[]} */
  #unsubscribe = [];
  /** @type {Messages} */
  #messages;
  /** @type {InstanceType<typeof KeySequencer>} */
  #keys;

  /**
   * @param {Registry} registry
   * @param {WindowStack} windows
   * @param {Messages} messages
   */
  constructor(registry, windows, messages) {
    super('core');
    this.#registry = registry;
    this.#windows = windows;
    this.#messages = messages;
    this.#keys = new KeySequencer({
      candidates: (focus) =>
        registry.activeKeybindings(focus, windows.top?.path).map(({ binding, command, handler, depth }) => ({
          keys: binding.keys,
          depth,
          run: () => {
            handler.call(command.method, ...binding.args).catch((error) => {
              messages.report(error, `Keybinding "${binding.key}" → ${binding.command} on "${handler.path}" failed`);
            });
          },
        })),
      onPending: (pending) => {
        this.state.pendingKeys = pending.join(' ');
      },
    });
  }

  onInit() {
    this.#keys.timeout = /** @type {number} */ (this.config.get('core.keyTimeout'));
    const registry = this.#registry;
    const windows = this.#windows;
    const messages = this.#messages;
    this.update({
      contributions: Object.fromEntries(registry.points.map((point) => [point, registry.get(point)])),
      windows: windows.windows,
      pendingKeys: '',
      messages: messages.list,
      colors: this.#colors(),
      quitting: false,
    });
    let focus = windows.focused;
    this.#unsubscribe.push(
      registry.subscribe((point) => {
        this.state.contributions[point] = registry.get(point);
        if (point === 'colors') {
          this.state.colors = this.#colors();
        }
      }),
      windows.subscribe(() => {
        this.state.windows = windows.windows;
        if (windows.focused !== focus) {
          // A sequence started in one window doesn't carry over to another.
          focus = windows.focused;
          this.#keys.reset();
        }
      }),
      messages.subscribe(() => {
        this.state.messages = messages.list;
      }),
    );
  }

  /**
   * Every declared color group's style, with the user's changes.
   * @returns {{ [id: string]: Style }}
   */
  #colors() {
    const groups = /** @type {import('../../colors').ColorGroup[]} */ (/** @type {unknown} */ (this.#registry.get('colors')));
    return Object.fromEntries(groups.map((group) => [group.id, this.config.style(group.id)]));
  }

  onDispose() {
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      unsubscribe();
    }
    this.#keys.reset();
  }

  /**
   * Runs a command from the TUI on the handler of its kind nearest to the focus.
   * @param {string} command A command id, e.g. `pane.down`.
   * @param {Data[]} [args]
   * @returns {Promise<unknown>} The command method's result.
   */
  execute(command, args = []) {
    return this.#registry.execute(command, { focus: this.#windows.focused?.path ?? null, args });
  }

  /**
   * Handles a key press from the UI: clears the messages shown — the user has had them in front of them —
   * then offers the character the key types, if any, to the focused handler (`Handler#onText`, e.g. a text
   * field); if it doesn't take it, runs the command the key completes for the focus, or waits for the rest
   * of a sequence. The command runs in the background; a failure is reported as a message.
   * @param {string} chord One canonical chord (`src/keys.js`), e.g. `j`, `shift+g`, `ctrl+w`.
   * @returns {boolean} Whether a keybinding used the key — if not, the UI may handle it itself.
   * @throws {TypeError} If `chord` isn't one canonical chord.
   */
  press(chord) {
    if (!isChord(chord)) {
      throw new TypeError(`"${chord}" isn't a single key in canonical notation, e.g. "j", "shift+g", "ctrl+w"`);
    }
    this.#messages.clear();
    const text = chordText(chord);
    if (text !== null && this.#offerText(text)) {
      this.#keys.reset();
      return true;
    }
    return this.#keys.press(chord, this.#windows.focused?.path ?? null);
  }

  /**
   * Handles text that came as a whole — a paste — by offering it to the focused handler
   * (`Handler#onText`), as if typed.
   * @param {string} text
   * @returns {boolean} Whether the focused handler took it.
   * @throws {TypeError} If `text` isn't a non-empty string.
   */
  type(text) {
    if (typeof text !== 'string' || !text) {
      throw new TypeError('Typed text must be a non-empty string');
    }
    this.#messages.clear();
    this.#keys.reset();
    return this.#offerText(text);
  }

  /**
   * @param {string} text
   * @returns {boolean} Whether the focused handler took it; a failure counts as taken, and is reported.
   */
  #offerText(text) {
    const focused = this.#windows.focused;
    if (!focused) {
      return false;
    }
    try {
      return focused.onText(text) === true;
    } catch (error) {
      this.#messages.report(error, `Typing into "${focused.path}" failed`);
      return true;
    }
  }

  /**
   * Clears the messages the user has seen — for a UI that shows them in a way a key dismisses, like the
   * TUI's popup, where the key does nothing else.
   * @param {number | null} [upTo] The `id` of the last message shown; ones that came after it stay.
   *   Default: all.
   * @throws {TypeError} If `upTo` isn't a number or `null`.
   */
  clearMessages(upTo = null) {
    if (upTo !== null && typeof upTo !== 'number') {
      throw new TypeError(`Expected a message id, got ${JSON.stringify(upTo)}`);
    }
    this.#messages.clear(upTo);
  }

  /**
   * Closes the window on top with `null` — the Escape key — unless it's the main window.
   * @returns {Promise<boolean>} Whether a window was closed.
   */
  closeWindow() {
    return this.#windows.closeTop();
  }

  /** Asks the UI to exit (`quitting`); once it has, `Vin#start` disposes the handlers and returns. */
  quit() {
    this.state.quitting = true;
  }
}

module.exports = Core;
