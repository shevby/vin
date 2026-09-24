/**
 * Color groups: how each part of the UI is drawn — its colors and text attributes — set in `config.json5`
 * under `colors`, by the kind that declares the group:
 *
 * ```json5
 * colors: {
 *   pane: { titleActive: { fg: 234, bg: 149, bold: true } },
 * }
 * ```
 *
 * Handlers declare groups in `static contributes.colors` (`{ key, default, description? }`), so the
 * default scheme lives next to the code that uses it. It's vifm's papercolor-dark
 * (https://github.com/vifm/vifm-colors/blob/master/papercolor-dark.vifm); each default notes the vifm group
 * it comes from. A user's entry changes only the fields it names, like vifm's `:highlight`.
 *
 * Colors are 256-color numbers, `#rrggbb` (or `#rgb`), a name (`blue`, `redBright`), or `default` — the
 * terminal's own. Terminals with fewer colors get the nearest ones.
 */

/**
 * @typedef {number | string} Color A 256-color number, `#rrggbb`, a name, or `default`.
 */

/**
 * @typedef {object} Style
 * @property {Color} [fg] Text color.
 * @property {Color} [bg] Background color.
 * @property {boolean} [bold]
 * @property {boolean} [italic]
 * @property {boolean} [underline]
 * @property {boolean} [inverse] Swaps the text and background colors.
 */

/**
 * A color group as declared in `static contributes.colors`.
 * @typedef {object} ColorContribution
 * @property {string} key A name; its id becomes `<kind>.<key>`.
 * @property {Style} default
 * @property {string} [description] Shown in the generated config file.
 */

/**
 * @typedef {object} ColorGroup
 * @property {string} id `<kind>.<key>`, e.g. `pane.titleActive`.
 * @property {string} kind The section of `colors` it's set in.
 * @property {string} key
 * @property {Style} default
 * @property {string | null} description
 * @property {string} source
 */

/** The color names terminals know, as chalk (which Ink draws with) spells them. */
const COLOR_NAMES = Object.freeze(
  ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((name) => [name, `${name}Bright`]).concat('gray', 'grey'),
);

const COLOR_FIELDS = ['fg', 'bg'];
const FLAG_FIELDS = ['bold', 'italic', 'underline', 'inverse'];

/**
 * Whether `value` is a color: a 256-color number, `#rgb`/`#rrggbb`, a name, or `default`.
 * @param {unknown} value
 * @returns {value is Color}
 */
function isColor(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= 255;
  }
  return typeof value === 'string' && (value === 'default' || COLOR_NAMES.includes(value) || /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value));
}

/**
 * Checks a style.
 * @param {unknown} value JSON data.
 * @returns {string | null} What's wrong, as the end of a sentence (`"fg" must be a color …; got 300`), or
 *   `null` if it's valid.
 */
function checkStyle(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `must be an object like { fg: 74, bold: true }; got ${JSON.stringify(value)}`;
  }
  for (const [field, item] of Object.entries(value)) {
    if (COLOR_FIELDS.includes(field)) {
      if (!isColor(item)) {
        return `"${field}" must be a color — 0 to 255, "#rrggbb", a name like "blue", or "default"; got ${JSON.stringify(item)}`;
      }
    } else if (FLAG_FIELDS.includes(field)) {
      if (typeof item !== 'boolean') {
        return `"${field}" must be true or false; got ${JSON.stringify(item)}`;
      }
    } else {
      return `has an unknown field "${field}"; expected ${[...COLOR_FIELDS, ...FLAG_FIELDS].map((f) => `"${f}"`).join(', ')}`;
    }
  }
  return null;
}

module.exports = { checkStyle, isColor, COLOR_NAMES };
