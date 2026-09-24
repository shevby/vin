import { useInput, useStdin } from 'ink';
import { log } from '../../../../src/log.js';
import { init } from '../../handler.js';
import { toChord } from './to-chord.js';

/**
 * Sends key presses to the backend's keybindings (`core.press`), which run the matching command on the
 * focused window — or the nearest one around it — or wait for the rest of a sequence.
 * @param {string | null} focus Path of the focused handler (`main.left`); `null` for none, which leaves
 *   only global (`core.*`) bindings.
 * @param {{ isActive?: boolean }} [options] `isActive: false` stops listening, e.g. while a text field has
 *   the keyboard.
 */
export function useKeybindings(focus, { isActive = true } = {}) {
  // Without a TTY (piped stdin) there are no key presses, and Ink would throw enabling raw mode.
  const { isRawModeSupported } = useStdin();
  useInput(
    (input, key) => {
      const chord = toChord(input, key);
      if (chord) {
        init('core')
          .press(chord, focus)
          .catch((/** @type {unknown} */ error) => log.error(`Key "${chord}" failed:`, error));
      }
    },
    { isActive: isActive && isRawModeSupported },
  );
}
