import { Box, Text } from 'ink';
import { useKeybindings } from './common/keys/index.js';

/** Root TUI component. It reaches the backend only through handles from `./handler.js`. */
export function App() {
  // No windows yet, so no focus: only global (core.*) bindings apply. The window manager (TODO 1.8) will
  // pass the focused window's path.
  useKeybindings(null);
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>vin — press Ctrl+C to quit</Text>
    </Box>
  );
}
