import { useEffect } from 'react';
import { Box, Text, useApp, useWindowSize } from 'ink';
import { JobStrip } from './common/jobs/index.js';
import { useKeybindings } from './common/keys/index.js';
import { MessageLine, MessagePopup } from './common/messages/index.js';
import { useSelector } from './common/store/index.js';
import { Theme, useBackground, useBorder, useStyle } from './common/theme/index.js';
import { Windows } from './common/windows/index.js';
import { init } from './handler.js';
import { windows } from './windows.js';

/**
 * Root TUI component: the open windows over the whole terminal, with the running jobs and then the message
 * line below them, and the message popup over everything, all in the color scheme (`core.window`'s background fills the screen).
 * It exits once the backend asks to (`core`'s `quitting`). It reaches the backend only through handles
 * from `./handler.js`.
 * @param {object} props
 * @param {{ [kind: string]: import('./common/windows/windows.jsx').WindowComponent }} [props.components] The
 *   component for each kind of window; default `./windows.js`.
 */
export function App({ components = windows }) {
  useKeybindings();
  const { exit } = useApp();
  const quitting = useSelector(init('core').store, (state) => state.quitting === true);
  useEffect(() => {
    if (quitting) {
      exit();
    }
  }, [quitting, exit]);
  return (
    <Theme>
      <Screen components={components} />
    </Theme>
  );
}

/**
 * @param {object} props
 * @param {{ [kind: string]: import('./common/windows/windows.jsx').WindowComponent }} props.components
 */
function Screen({ components }) {
  const { columns, rows } = useWindowSize();
  const background = useBackground();
  const border = useBorder();
  const text = useStyle('core.window');
  // One row short of the terminal: a frame as tall as the terminal makes Ink clear the whole screen on every
  // render in the Windows console, which flickers.
  const height = Math.max(2, rows - 1);
  return (
    <Box width={columns} height={height} flexDirection="column" backgroundColor={background}>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <Windows components={components}>
          <Box borderStyle="round" {...border} paddingX={1}>
            <Text {...text}>vin — press z z to quit</Text>
          </Box>
        </Windows>
      </Box>
      <JobStrip columns={columns} />
      <MessageLine columns={columns} />
      <MessagePopup columns={columns} rows={height} />
    </Box>
  );
}
