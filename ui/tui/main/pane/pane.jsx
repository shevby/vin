import { Box, Text } from 'ink';
import { paths } from '../../../../src/paths.js';
import { init } from '../../handler.js';
import { useSelector } from '../../common/store/index.js';

/**
 * One pane of the main window (`src/handlers/main/pane/`): a box with the directory it shows set into its
 * top border — cut from the start when it doesn't fit, so the end of the path stays. The active pane's
 * border is highlighted. Its listing comes with 2.2.
 * @param {object} props
 * @param {string} props.path The pane's handler, e.g. `main.left`.
 * @param {boolean} props.active
 */
export function Pane({ path, active }) {
  const uri = useSelector(init(path).store, (state) => /** @type {string | null} */ (state.uri ?? null));
  return (
    <Box flexGrow={1} flexBasis={0} flexDirection="column" borderStyle="round" borderColor={active ? 'cyan' : undefined} borderDimColor={!active}>
      {uri !== null && (
        // Over the top border, leaving a corner and a line at each end.
        <Box position="absolute" top={-1} left={1} right={1}>
          <Text> </Text>
          <Box flexShrink={1}>
            <Text bold={active} wrap="truncate-start">
              {paths.displayUri(uri)}
            </Text>
          </Box>
          <Text> </Text>
        </Box>
      )}
    </Box>
  );
}
