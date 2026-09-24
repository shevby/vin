import { Box, Text, useWindowSize } from 'ink';
import { init } from '../handler.js';
import { useSelector } from '../common/store/index.js';

/** @typedef {import('../../../src/handlers/choice-list/choice-list.js').ChoiceState} ChoiceState */

/** @type {ChoiceState[]} */
const NONE = [];

/** Rows the window keeps for its border, title, message, and the gap between them. */
const CHROME = 8;

/**
 * The window of a `ChoiceList` handler (`src/handlers/choice-list/`): the options, the highlighted one
 * inverted, each after the key that picks it. A list taller than the screen scrolls with the highlight.
 * @param {{ path: string }} props
 */
export function ChoiceList({ path }) {
  const { rows } = useWindowSize();
  const { store } = init(path);
  const title = useSelector(store, (state) => /** @type {string | null} */ (state.title ?? null));
  const message = useSelector(store, (state) => /** @type {string | null} */ (state.message ?? null));
  const choices = useSelector(store, (state) => /** @type {ChoiceState[]} */ (state.choices ?? NONE));
  const selected = useSelector(store, (state) => /** @type {number} */ (state.selected ?? 0));
  const room = Math.max(1, rows - CHROME);
  const start = Math.min(Math.max(0, selected - room + 1), Math.max(0, choices.length - room));
  const hasKeys = choices.some((choice) => choice.key !== null);
  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      {title && <Text bold>{title}</Text>}
      {message && <Text>{message}</Text>}
      <Box flexDirection="column" marginTop={title || message ? 1 : 0}>
        {choices.slice(start, start + room).map((choice, i) => (
          <Text key={start + i} wrap="truncate-end">
            {hasKeys && <Text color="cyan">{choice.key ?? ' '} </Text>}
            <Text inverse={start + i === selected}>{choice.label}</Text>
            {choice.description && <Text dimColor> {choice.description}</Text>}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
