import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { init, release } from '../../handler.js';
import { useSelector } from '../store/index.js';

/**
 * @typedef {import('../../../../src/windows.js').WindowInfo} WindowInfo
 * @typedef {import('react').ComponentType<{ path: string }>} WindowComponent
 */

/** @type {WindowInfo[]} */
const NONE = [];

/**
 * Not a color Ink knows, so it paints a box's background with plain spaces in the terminal's own colors —
 * which is what makes an overlay opaque without choosing a color for it.
 */
const BLANK = 'blank';

/**
 * The open windows, bottom to top, from `core`'s state. When a window closes — or is replaced by another
 * opened at the same path — the stores of its handlers are released, before anything renders the change,
 * so a window opened again never shows the old handler's state.
 * @returns {WindowInfo[]}
 */
export function useWindows() {
  const { store } = init('core');
  // Declared before useSelector, so it's subscribed first and releases before the re-render.
  useEffect(() => {
    /** @param {unknown} windows */
    const ids = (windows) => new Map((/** @type {WindowInfo[] | undefined} */ (windows) ?? NONE).map((window) => [window.path, window.id]));
    let open = ids(store.getSnapshot().windows);
    return store.subscribe(() => {
      const next = ids(store.getSnapshot().windows);
      for (const [path, id] of open) {
        if (next.get(path) !== id) {
          release(path);
        }
      }
      open = next;
    });
  }, [store]);
  return useSelector(store, (state) => state.windows ?? NONE);
}

/**
 * Path of the handler that has the focus — within the top window — or `null` when no window is open.
 * @returns {string | null}
 */
export function useFocus() {
  return useSelector(init('core').store, (state) => state.windows?.at(-1)?.focus ?? null);
}

/**
 * Draws the open windows: the bottom one fills the area, and each one above it is an overlay, centered on
 * top. A window is drawn by the component for its handler's kind.
 * @param {object} props
 * @param {{ [kind: string]: WindowComponent }} props.components
 * @param {import('react').ReactNode} [props.children] Shown while no window is open.
 */
export function Windows({ components, children }) {
  const windows = useWindows();
  if (!windows.length) {
    return <>{children}</>;
  }
  const [base, ...overlays] = windows;
  return (
    <Box flexGrow={1} flexDirection="column">
      <Window window={base} components={components} />
      {overlays.map((window) => (
        <Box key={window.id} position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
          <Box backgroundColor={BLANK} flexDirection="column">
            <Window window={window} components={components} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/**
 * @param {object} props
 * @param {WindowInfo} props.window
 * @param {{ [kind: string]: WindowComponent }} props.components
 */
function Window({ window, components }) {
  const Component = Object.hasOwn(components, window.kind) ? components[window.kind] : null;
  if (!Component) {
    return (
      <Box borderStyle="round" paddingX={1}>
        <Text>No TUI for window "{window.path}" ({window.kind})</Text>
      </Box>
    );
  }
  return <Component key={window.id} path={window.path} />;
}
