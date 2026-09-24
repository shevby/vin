import { render, Box, Text } from 'ink';

/** @typedef {import('../../src/vin.js')} Vin */

/**
 * Root TUI component.
 * @param {{ vin: Vin }} props
 */
function App({ vin }) {
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>vin — press Ctrl+C to quit</Text>
    </Box>
  );
}

/**
 * Renders the TUI and resolves once it exits.
 * @param {Vin} vin
 * @returns {Promise<void>}
 */
export async function start(vin) {
  const { waitUntilExit } = render(<App vin={vin} />);
  await waitUntilExit();
}
