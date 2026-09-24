/**
 * How the listing shows sizes and times (2.2), in `ls -lh` style — shared by every UI, so they agree.
 */

const UNITS = ['K', 'M', 'G', 'T', 'P', 'E'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A size in bytes, 1024-based, in at most 6 cells: `312 B`, `4.2 K`, `18 M`, `1023 K` — one decimal below
 * 10 of a unit, whole numbers above.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes / 1024;
  let unit = 0;
  // What would round to 1024 of a unit shows as 1.0 of the next.
  while (Math.round(value) >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/**
 * A time in 12 cells, local: `Sep 24 14:03` within `year`, `Mar  2  2024` otherwise.
 * @param {number} ms Since the epoch.
 * @param {number} [year] Default: this one.
 * @returns {string}
 */
function formatTime(ms, year = new Date().getFullYear()) {
  const date = new Date(ms);
  const day = `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2)}`;
  if (date.getFullYear() !== year) {
    return `${day} ${String(date.getFullYear()).padStart(5)}`;
  }
  const time = [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':');
  return `${day} ${time}`;
}

module.exports = { formatSize, formatTime };
