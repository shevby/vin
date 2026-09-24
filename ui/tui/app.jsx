import { Box, Text } from 'ink';

/** @typedef {import('../../src/vin.js')} Vin */

/**
 * Root TUI component.
 * @param {{ vin: Vin }} props
 */
export function App({ vin }) {
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>vin — press Ctrl+C to quit</Text>
    </Box>
  );
}
