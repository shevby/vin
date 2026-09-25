import { useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { log } from '../../../../src/log.js';
import { paths } from '../../../../src/paths.js';
import { describeSort } from '../../../../src/handlers/main/pane/sorting.js';
import { init } from '../../handler.js';
import { useSelector } from '../../common/store/index.js';
import { useBorder, useStyle } from '../../common/theme/index.js';
import { Listing } from './listing.jsx';

/**
 * @typedef {import('../../../../src/handlers/main/pane/pane.js').Entry} Entry
 * @typedef {import('../../../../src/handlers/main/pane/pane.js').Status} Status
 * @typedef {import('../../../../src/handlers/main/pane/sorting.js').Sort} Sort
 */

/** @type {Entry[]} */
const NO_ENTRIES = [];
/** @type {string[]} */
const NO_NAMES = [];

/**
 * How many entries are selected, counting the group being selected, without counting any twice.
 * @param {Entry[]} entries
 * @param {string[]} selected
 * @param {number | null} range
 * @param {number} cursor
 * @returns {number}
 */
export function selectionCount(entries, selected, range, cursor) {
  if (range === null) {
    return selected.length;
  }
  const names = new Set(selected);
  let count = selected.length;
  for (let i = Math.min(range, cursor); i <= Math.max(range, cursor) && i < entries.length; i++) {
    count += Number(!names.has(entries[i].name));
  }
  return count;
}

/**
 * What the bottom border says about the view, when it isn't the usual: the order, unless it's by name
 * with directories first, and how many entries are hidden.
 * @param {Sort | null} sort
 * @param {number} hiddenCount
 * @returns {string}
 */
export function viewNote(sort, hiddenCount) {
  const notes = [];
  if (sort && (sort.by !== 'name' || sort.reverse)) {
    notes.push(describeSort(sort));
  }
  if (sort && !sort.directoriesFirst) {
    notes.push('directories mixed in');
  }
  if (hiddenCount) {
    notes.push(`${hiddenCount} hidden`);
  }
  return notes.join(' · ');
}

/**
 * One pane of the main window (`src/handlers/main/pane/`): a box with the directory it shows set into its
 * top border — cut from the start when it doesn't fit, so the end of the path stays — in `pane.titleActive`
 * for the active pane and `pane.title` for the other — and its listing inside, whose height it reports for
 * the page keys. While entries are selected, the bottom border says how many, and while a group is being
 * selected, that it is; its left end says the order, when it isn't by name, and how many entries are
 * hidden (`viewNote()`).
 * @param {object} props
 * @param {string} props.path The pane's handler, e.g. `main.left`.
 * @param {boolean} props.active
 */
export function Pane({ path, active }) {
  const { store } = init(path);
  const uri = useSelector(store, (state) => /** @type {string | null} */ (state.uri ?? null));
  const status = useSelector(store, (state) => /** @type {Status} */ (state.status ?? 'loading'));
  const entries = useSelector(store, (state) => /** @type {Entry[]} */ (/** @type {unknown} */ (state.entries ?? NO_ENTRIES)));
  const cursor = useSelector(store, (state) => /** @type {number} */ (state.cursor ?? 0));
  const selected = useSelector(store, (state) => /** @type {string[]} */ (/** @type {unknown} */ (state.selected ?? NO_NAMES)));
  const range = useSelector(store, (state) => /** @type {number | null} */ (state.range ?? null));
  const sort = useSelector(store, (state) => /** @type {Sort | null} */ (/** @type {unknown} */ (state.sort ?? null)));
  const hiddenCount = useSelector(store, (state) => /** @type {number} */ (state.hiddenCount ?? 0));
  const onHeight = useCallback((/** @type {number} */ rows) => {
    init(path).setPageSize(rows).catch((/** @type {unknown} */ error) => log.error('Reporting the page size failed:', error));
  }, [path]);
  const border = useBorder();
  const title = useStyle(active ? 'pane.titleActive' : 'pane.title');
  const selectedStyle = useStyle('pane.selected');
  const noteStyle = useStyle('pane.sort');
  const note = viewNote(sort, hiddenCount);
  const count = useMemo(() => selectionCount(entries, selected, range, cursor), [entries, selected, range, cursor]);
  return (
    <Box flexGrow={1} flexBasis={0} flexDirection="column" borderStyle="round" {...border}>
      {uri !== null && (
        // Over the top border, leaving a corner and a line at each end.
        <Box position="absolute" top={-1} left={1} right={1}>
          <Text {...title}> </Text>
          <Box flexShrink={1}>
            <Text {...title} wrap="truncate-start">
              {paths.displayUri(uri)}
            </Text>
          </Box>
          <Text {...title}> </Text>
        </Box>
      )}
      {note && (
        // Over the bottom border, at its left end.
        <Box position="absolute" bottom={-1} left={1}>
          <Text {...noteStyle} wrap="truncate-end">{` ${note} `}</Text>
        </Box>
      )}
      {(count > 0 || range !== null) && (
        // Over the bottom border, at its right end.
        <Box position="absolute" bottom={-1} right={1}>
          <Text {...selectedStyle}>{` ${range === null ? '' : 'GROUP: '}${count} selected `}</Text>
        </Box>
      )}
      <Listing entries={entries} cursor={cursor} selected={selected} range={range} status={status} active={active} onHeight={onHeight} />
    </Box>
  );
}
