import { render } from 'ink';
import { App } from './app.jsx';
import { connect, disconnect } from './handler.js';

/** @typedef {import('../../src/transport.js').Transport} Transport */

/**
 * Connects the TUI to the backend, renders it, and resolves once it exits.
 * @param {Transport} transport
 * @returns {Promise<void>}
 */
export async function start(transport) {
  connect(transport);
  try {
    // The alternate screen, like vim and vifm: the shell's scrollback is left as it was on exit. Ctrl+C is
    // an ordinary key (copy), so vin quits only through its keybindings (`core.quit`). The kitty keyboard
    // protocol, where the terminal has it, reports Cmd (`cmd+c`) and keys legacy input can't tell apart.
    const { waitUntilExit } = render(<App />, {
      alternateScreen: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: 'auto' },
    });
    await waitUntilExit();
  } finally {
    disconnect();
  }
}
