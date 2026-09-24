import { render } from 'ink';
import { App } from './app.jsx';

/** @typedef {import('../../src/vin.js')} Vin */

/**
 * Renders the TUI and resolves once it exits.
 * @param {Vin} vin
 * @returns {Promise<void>}
 */
export async function start(vin) {
  const { waitUntilExit } = render(<App vin={vin} />);
  await waitUntilExit();
}
