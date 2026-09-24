import { Box, Text, useWindowSize } from 'ink';
import { useKeybindings } from './common/keys/index.js';
import { Windows } from './common/windows/index.js';
import { windows } from './windows.js';

/**
 * Root TUI component: the open windows over the whole terminal. It reaches the backend only through handles
 * from `./handler.js`.
 * @param {object} props
 * @param {{ [kind: string]: import('./common/windows/windows.jsx').WindowComponent }} [props.components] The
 *   component for each kind of window; default `./windows.js`.
 */
export function App({ components = windows }) {
  useKeybindings();
  const { columns, rows } = useWindowSize();
  // One row short of the terminal: a frame as tall as the terminal makes Ink clear the whole screen on every
  // render in the Windows console, which flickers.
  return (
    <Box width={columns} height={Math.max(1, rows - 1)} flexDirection="column">
      <Windows components={components}>
        <Box borderStyle="round" paddingX={1}>
          <Text>vin — press Ctrl+C to quit</Text>
        </Box>
      </Windows>
    </Box>
  );
}
