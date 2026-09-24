import { useInput, useStdin, useWindowSize } from 'ink';
import { log } from '../../../../src/log.js';
import { init } from '../../handler.js';
import { needsPopup, useMessages } from '../messages/index.js';
import { toChord } from './to-chord.js';

/**
 * Sends key presses to the backend's keybindings (`core.press`), which run the matching command on the
 * focus within the top window — or the nearest handler around it — or wait for the rest of a sequence.
 * The backend owns the focus, so one call at the root of the UI is enough.
 *
 * While the message popup is up, a key only dismisses it (`core.clearMessages`), so keys typed before it
 * appeared don't act on what's behind it.
 * @param {{ isActive?: boolean }} [options] `isActive: false` stops listening, e.g. while a text field has
 *   the keyboard.
 */
export function useKeybindings({ isActive = true } = {}) {
  // Without a TTY (piped stdin) there are no key presses, and Ink would throw enabling raw mode. Ink
  // reports support as stdin.isTTY — undefined for a pipe — and only an explicit false disables useInput.
  const { isRawModeSupported } = useStdin();
  const { columns } = useWindowSize();
  const messages = useMessages();
  const popup = needsPopup(messages, columns);
  const lastMessage = messages.at(-1)?.id ?? null;
  useInput(
    (input, key) => {
      const chord = toChord(input, key);
      if (!chord) {
        return;
      }
      const core = init('core');
      const call = popup ? core.clearMessages(lastMessage) : core.press(chord);
      call.catch((/** @type {unknown} */ error) => log.error(`Key "${chord}" failed:`, error));
    },
    { isActive: isActive && isRawModeSupported === true },
  );
}
