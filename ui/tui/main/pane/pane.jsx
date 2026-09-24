import { useCallback } from 'react';
import { Box, Text } from 'ink';
import { log } from '../../../../src/log.js';
import { paths } from '../../../../src/paths.js';
import { init } from '../../handler.js';
import { useSelector } from '../../common/store/index.js';
import { useBorder, useStyle } from '../../common/theme/index.js';
import { Listing } from './listing.jsx';

/**
 * @typedef {import('../../../../src/handlers/main/pane/pane.js').Entry} Entry
 * @typedef {import('../../../../src/handlers/main/pane/pane.js').Status} Status
 */

/** @type {Entry[]} */
const NO_ENTRIES = [];

/**
 * One pane of the main window (`src/handlers/main/pane/`): a box with the directory it shows set into its
 * top border — cut from the start when it doesn't fit, so the end of the path stays — in `pane.titleActive`
 * for the active pane and `pane.title` for the other — and its listing inside, whose height it reports for
 * the page keys.
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
  const onHeight = useCallback((/** @type {number} */ rows) => {
    init(path).setPageSize(rows).catch((/** @type {unknown} */ error) => log.error('Reporting the page size failed:', error));
  }, [path]);
  const border = useBorder();
  const title = useStyle(active ? 'pane.titleActive' : 'pane.title');
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
      <Listing entries={entries} cursor={cursor} status={status} active={active} onHeight={onHeight} />
    </Box>
  );
}
