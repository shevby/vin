import { Box, Text, useWindowSize } from 'ink';
import { init } from '../handler.js';
import { useSelector } from '../common/store/index.js';
import { TextField } from '../common/text-field/index.js';

/** The widest a prompt's text field gets, in columns. */
const MAX_WIDTH = 60;

/**
 * The window of a `Prompt` handler (`src/handlers/prompt/`): the question, the text being edited, and the
 * validation error, if any.
 * @param {{ path: string }} props
 */
export function Prompt({ path }) {
  const { columns } = useWindowSize();
  const { store } = init(path);
  const title = useSelector(store, (state) => /** @type {string | null} */ (state.title ?? null));
  const message = useSelector(store, (state) => /** @type {string | null} */ (state.message ?? null));
  const error = useSelector(store, (state) => /** @type {string | null} */ (state.error ?? null));
  // The borders and padding of both boxes take 8 columns.
  const width = Math.max(10, Math.min(MAX_WIDTH, columns - 8));
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {title && <Text bold>{title}</Text>}
      {message && <Text>{message}</Text>}
      <Box borderStyle="single" borderDimColor paddingX={1}>
        <TextField path={`${path}.input`} width={width} />
      </Box>
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}
