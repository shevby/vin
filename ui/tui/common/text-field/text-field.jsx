import { Box, Text } from 'ink';
import { init } from '../../handler.js';
import { useSelector } from '../store/index.js';
import { useStyle } from '../theme/index.js';
import { useFocus } from '../windows/index.js';

/**
 * Draws a text field handler (`src/handlers/text-field/`) on one line: its text — as `•`s if it's secret —
 * with the cursor as a cell in `core.cursor` while it has the focus. Text wider than the field scrolls to keep the
 * cursor in view.
 * @param {object} props
 * @param {string} props.path The text field handler, e.g. `main.prompt.input`.
 * @param {number} props.width In columns.
 */
export function TextField({ path, width }) {
  const { store } = init(path);
  const value = useSelector(store, (state) => /** @type {string} */ (state.value ?? ''));
  const cursor = useSelector(store, (state) => /** @type {number} */ (state.cursor ?? 0));
  const secret = useSelector(store, (state) => state.secret === true);
  const focused = useFocus() === path;
  const text = useStyle('core.window');
  const cursorStyle = useStyle('core.cursor');
  const { before, at, after } = visible([...value].map((char) => (secret ? '•' : char)), cursor, width);
  return (
    <Box width={width} height={1}>
      <Text {...text} wrap="truncate-end">
        {before}
        {focused ? <Text {...cursorStyle}>{at}</Text> : at}
        {after}
      </Text>
    </Box>
  );
}

/**
 * The part of a line that fits in `width` columns with the cursor in view, split around the cursor. A
 * cursor after the last character sits on a space.
 * @param {string[]} chars
 * @param {number} cursor
 * @param {number} width
 * @returns {{ before: string, at: string, after: string }}
 */
export function visible(chars, cursor, width) {
  const room = Math.max(1, width);
  const cells = [...chars, ' '];
  const start = Math.max(0, cursor - room + 1);
  const shown = cells.slice(start, start + room);
  const at = cursor - start;
  return { before: shown.slice(0, at).join(''), at: shown[at] ?? ' ', after: shown.slice(at + 1).join('') };
}
