import { Box, Text } from 'ink';

/** Root TUI component. It reaches the backend only through handles from `./handler.js`. */
export function App() {
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>vin — press Ctrl+C to quit</Text>
    </Box>
  );
}
