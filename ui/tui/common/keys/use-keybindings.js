import { useInput, usePaste, useStdin, useWindowSize } from 'ink';
import { log } from '../../../../src/log.js';
import { init } from '../../handler.js';
import { needsPopup, useMessages } from '../messages/index.js';
import { toChord } from './to-chord.js';

/**
 * Sends key presses to the backend's keybindings (`core.press`), which run the matching command on the
 * focus within the top window — or the nearest handler around it — or wait for the rest of a sequence; a
 * key that types a character goes to a focused text field first. Pasted text goes to the focus as a whole
 * (`core.type`). The backend owns the focus, so one call at the root of the UI is enough.
 *
 * While the message popup is up, a key only dismisses it (`core.clearMessages`), so keys typed before it
 * appeared don't act on what's behind it.
 * @param {{ isActive?: boolean }} [options] `isActive: false` stops listening.
 */
export function useKeybindings({ isActive = true } = {}) {
  // Without a TTY (piped stdin) there are no key presses, and Ink would throw enabling raw mode. Ink
  // reports support as stdin.isTTY — undefined for a pipe — and only an explicit false disables useInput.
  const { isRawModeSupported } = useStdin();
  const { columns } = useWindowSize();
  const messages = useMessages();
  const popup = needsPopup(messages, columns);
  const lastMessage = messages.at(-1)?.id ?? null;
  const active = isActive && isRawModeSupported === true;

  /**
   * @param {string} what For the log.
   * @param {() => Promise<unknown>} call
   */
  const send = (what, call) => {
    const core = init('core');
    (popup ? core.clearMessages(lastMessage) : call()).catch((/** @type {unknown} */ error) => log.error(`${what} failed:`, error));
  };

  useInput(
    (input, key) => {
      const chord = toChord(input, key);
      if (chord) {
        send(`Key "${chord}"`, () => init('core').press(chord));
      } else if (input && !key.ctrl && !key.meta) {
        // Several characters at once: a paste the terminal didn't bracket, or keys typed faster than read.
        send('Typing', () => init('core').type(input));
      }
    },
    { isActive: active },
  );
  usePaste(
    (text) => {
      if (text) {
        send('Pasting', () => init('core').type(text));
      }
    },
    { isActive: active },
  );
}
