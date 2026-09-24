import { Box } from 'ink';
import { init } from '../handler.js';
import { useSelector } from '../common/store/index.js';
import { Pane } from './pane/index.js';

/** @typedef {'left' | 'right'} Side */

/**
 * The main window (`src/handlers/main/`): both panes side by side, sharing the width equally, or — in
 * single-pane mode — only the active one.
 * @param {{ path: string }} props
 */
export function Main({ path }) {
  const { store } = init(path);
  const active = useSelector(store, (state) => /** @type {Side} */ (state.active ?? 'left'));
  const singlePane = useSelector(store, (state) => state.singlePane === true);
  /** @type {Side[]} */
  const shown = singlePane ? [active] : ['left', 'right'];
  return (
    <Box flexGrow={1}>
      {shown.map((side) => (
        <Pane key={side} path={`${path}.${side}`} active={side === active} />
      ))}
    </Box>
  );
}
