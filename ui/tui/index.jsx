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
    const { waitUntilExit } = render(<App />);
    await waitUntilExit();
  } finally {
    disconnect();
  }
}
