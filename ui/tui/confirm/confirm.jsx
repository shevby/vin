import { Box, Text } from 'ink';
import { init } from '../handler.js';
import { useSelector } from '../common/store/index.js';

/**
 * The window of a `Confirm` handler (`src/handlers/confirm/`): the question and its two buttons, the
 * highlighted one inverted.
 * @param {{ path: string }} props
 */
export function Confirm({ path }) {
  const { store } = init(path);
  const title = useSelector(store, (state) => /** @type {string | null} */ (state.title ?? null));
  const message = useSelector(store, (state) => /** @type {string} */ (state.message ?? ''));
  const yes = useSelector(store, (state) => /** @type {string} */ (state.yes ?? 'Yes'));
  const no = useSelector(store, (state) => /** @type {string} */ (state.no ?? 'No'));
  const selected = useSelector(store, (state) => state.selected);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {title && <Text bold>{title}</Text>}
      <Text>{message}</Text>
      <Box marginTop={1} gap={2} justifyContent="center">
        <Text inverse={selected === 'yes'}> {yes} </Text>
        <Text inverse={selected === 'no'}> {no} </Text>
      </Box>
    </Box>
  );
}
