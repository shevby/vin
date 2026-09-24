import { Box, Text } from 'ink';
import { init } from '../handler.js';
import { useSelector } from '../common/store/index.js';
import { useBorder, useStyle } from '../common/theme/index.js';

/**
 * The window of a `Confirm` handler (`src/handlers/confirm/`): the question and its two buttons, the
 * highlighted one in `core.highlight`.
 * @param {{ path: string }} props
 */
export function Confirm({ path }) {
  const { store } = init(path);
  const title = useSelector(store, (state) => /** @type {string | null} */ (state.title ?? null));
  const message = useSelector(store, (state) => /** @type {string} */ (state.message ?? ''));
  const yes = useSelector(store, (state) => /** @type {string} */ (state.yes ?? 'Yes'));
  const no = useSelector(store, (state) => /** @type {string} */ (state.no ?? 'No'));
  const selected = useSelector(store, (state) => state.selected);
  const text = useStyle('core.window');
  const highlight = useStyle('core.highlight');
  const heading = useStyle('core.title');
  const border = useBorder();
  return (
    <Box borderStyle="round" {...border} flexDirection="column" paddingX={1}>
      {title && <Text {...heading}>{title}</Text>}
      <Text {...text}>{message}</Text>
      <Box marginTop={1} gap={2} justifyContent="center">
        <Text {...(selected === 'yes' ? highlight : text)}> {yes} </Text>
        <Text {...(selected === 'no' ? highlight : text)}> {no} </Text>
      </Box>
    </Box>
  );
}
