/**
 * A name: a letter, then letters, digits, `-` or `_` — no dots, since dots separate the segments of a path
 * (`main.left`, `main.left.changed`). Handler names, handler kinds, and event names all follow it.
 */
const NAME_PATTERN = /^[A-Za-z][\w-]*$/;

/**
 * @param {unknown} name
 * @returns {name is string}
 */
function isName(name) {
  return typeof name === 'string' && NAME_PATTERN.test(name);
}

/**
 * Whether `path` is at least `min` names joined by dots.
 * @param {unknown} path
 * @param {number} [min]
 * @returns {path is string}
 */
function isPath(path, min = 1) {
  if (typeof path !== 'string') {
    return false;
  }
  const segments = path.split('.');
  return segments.length >= min && segments.every((segment) => NAME_PATTERN.test(segment));
}

module.exports = { isName, isPath };
