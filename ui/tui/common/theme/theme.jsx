import { createContext, useContext, useMemo } from 'react';
import { init } from '../../handler.js';
import { useSelector } from '../store/index.js';

/**
 * @typedef {import('../../../../src/colors.js').Style} Style
 * @typedef {import('../../../../src/colors.js').Color} Color
 * @typedef {{ [id: string]: Style }} Colors
 * @typedef {{ color?: string, backgroundColor?: string, bold?: boolean, italic?: boolean, underline?: boolean, inverse?: boolean }} TextStyle
 */

/** @type {Colors} */
const NONE = {};

/** No scheme — terminal colors — until `Theme` provides one, so components render alone in tests too. */
const ThemeContext = createContext(NONE);

/**
 * Provides the color scheme — `core`'s `colors` state (`src/colors.js`) — to everything inside it.
 * @param {{ children: import('react').ReactNode }} props
 */
export function Theme({ children }) {
  const colors = useSelector(init('core').store, (state) => /** @type {Colors} */ (state.colors ?? NONE));
  return <ThemeContext.Provider value={colors}>{children}</ThemeContext.Provider>;
}

/**
 * A color as Ink takes it: a 256-color number as `ansi256(n)`, `default` as none — the terminal's own.
 * @param {Color | undefined} color
 * @returns {string | undefined}
 */
export function inkColor(color) {
  if (color === undefined || color === 'default') {
    return undefined;
  }
  return typeof color === 'number' ? `ansi256(${color})` : color;
}

/**
 * A style as `<Text>` props. Text without a color of its own takes the window's (`core.window`), so
 * `inverse` swaps the scheme's colors, not the terminal's; the background comes from the enclosing box
 * unless the style sets one.
 * @param {Style | undefined} style
 * @param {Style | undefined} window
 * @returns {TextStyle}
 */
export function textStyle(style, window) {
  /** @type {TextStyle} */
  const props = {};
  const color = inkColor(style?.fg ?? window?.fg);
  const backgroundColor = inkColor(style?.bg);
  if (color) {
    props.color = color;
  }
  if (backgroundColor) {
    props.backgroundColor = backgroundColor;
  }
  for (const flag of /** @type {const} */ (['bold', 'italic', 'underline', 'inverse'])) {
    if (style?.[flag] !== undefined) {
      props[flag] = style[flag];
    }
  }
  return props;
}

/**
 * `<Text>` props for a color group: `<Text {...useStyle('core.error')}>`.
 * @param {string} id E.g. `core.error`, `pane.titleActive`.
 * @returns {TextStyle}
 */
export function useStyle(id) {
  const colors = useContext(ThemeContext);
  const style = colors[id];
  const window = colors['core.window'];
  return useMemo(() => textStyle(style, window), [style, window]);
}

/**
 * The scheme's background for windows (`core.window`), or `undefined` for the terminal's own.
 * @returns {string | undefined}
 */
export function useBackground() {
  return inkColor(useContext(ThemeContext)['core.window']?.bg);
}

/**
 * `<Box>` props for a border drawn in a color group — `core.border` by default — on the window's
 * background.
 * @param {string} [id]
 * @returns {{ borderColor?: string, borderBackgroundColor?: string }}
 */
export function useBorder(id = 'core.border') {
  const colors = useContext(ThemeContext);
  const style = colors[id];
  const window = colors['core.window'];
  return useMemo(() => {
    /** @type {{ borderColor?: string, borderBackgroundColor?: string }} */
    const props = {};
    const color = inkColor(style?.fg ?? window?.fg);
    const background = inkColor(style?.bg ?? window?.bg);
    if (color) {
      props.borderColor = color;
    }
    if (background) {
      props.borderBackgroundColor = background;
    }
    return props;
  }, [style, window]);
}
