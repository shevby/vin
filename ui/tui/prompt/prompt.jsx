import { Box, Text, useWindowSize } from 'ink';
import { init } from '../handler.js';
import { useSelector } from '../common/store/index.js';
import { TextField } from '../common/text-field/index.js';
import { useBorder, useStyle } from '../common/theme/index.js';

/** The widest a prompt's text field gets, in columns. */
const MAX_WIDTH = 60;

/**
 * The window of a `Prompt` handler (`src/handlers/prompt/`): the question, the text being edited, the
 * validation error, if any, and the preview of what the text would do, dimmed, each of its lines cut to fit.
 * @param {{ path: string }} props
 */
export function Prompt({ path }) {
  const { columns } = useWindowSize();
  const { store } = init(path);
  const title = useSelector(store, (state) => /** @type {string | null} */ (state.title ?? null));
  const message = useSelector(store, (state) => /** @type {string | null} */ (state.message ?? null));
  const error = useSelector(store, (state) => /** @type {string | null} */ (state.error ?? null));
  const preview = useSelector(store, (state) => /** @type {string | null} */ (state.preview ?? null));
  const border = useBorder();
  const fieldBorder = useBorder('core.hint');
  const heading = useStyle('core.title');
  const text = useStyle('core.window');
  const failure = useStyle('core.error');
  const hint = useStyle('core.hint');
  // The borders and padding of both boxes take 8 columns.
  const width = Math.max(10, Math.min(MAX_WIDTH, columns - 8));
  return (
    <Box borderStyle="round" {...border} flexDirection="column" paddingX={1}>
      {title && <Text {...heading}>{title}</Text>}
      {message && <Text {...text}>{message}</Text>}
      <Box borderStyle="single" {...fieldBorder} paddingX={1}>
        <TextField path={`${path}.input`} width={width} />
      </Box>
      {error && <Text {...failure}>{error}</Text>}
      {preview && preview.split('\n').map((line, i) => (
        // Lines of a preview don't move, so their index is their key.
        <Box key={i} width={width + 4}>
          <Text {...hint} wrap="truncate-end">{line}</Text>
        </Box>
      ))}
    </Box>
  );
}
