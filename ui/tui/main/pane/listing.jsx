import { memo, useEffect, useMemo, useRef } from 'react';
import { Box, Text, useBoxMetrics } from 'ink';
import { formatSize, formatTime } from '../../../../src/format.js';
import { useLineStyle, useStyle } from '../../common/theme/index.js';

/**
 * @typedef {import('../../../../src/handlers/main/pane/pane.js').Entry} Entry
 * @typedef {import('../../../../src/handlers/main/pane/pane.js').Status} Status
 * @typedef {{ size: boolean, time: boolean }} Columns
 */

/** Cells of the size and modified columns (`src/format.js`), each after a space. */
const SIZE_WIDTH = 6;
const TIME_WIDTH = 12;
/** What marks a selected entry, in the gutter shown while anything is. */
const CHECK = '✓';

/** Cells a name keeps before a narrow pane drops the modified column, then the size one. */
const MIN_NAME = 16;

/**
 * The first row shown: the previous one, scrolled just enough to show the cursor, and never leaving rows
 * empty below the last entry while there are entries above the first.
 * @param {number} top The first row shown before.
 * @param {number} cursor
 * @param {number} height Rows that fit.
 * @param {number} count Entries.
 * @returns {number}
 */
export function scrollTop(top, cursor, height, count) {
  if (height <= 0) {
    return 0;
  }
  let next = Math.min(top, cursor);
  if (cursor >= next + height) {
    next = cursor - height + 1;
  }
  return Math.max(0, Math.min(next, count - height));
}

/**
 * The columns that fit a pane's width next to a name of `MIN_NAME` cells.
 * @param {number} width
 * @returns {Columns}
 */
export function columnsFor(width) {
  return {
    size: width >= MIN_NAME + 1 + SIZE_WIDTH,
    time: width >= MIN_NAME + 1 + SIZE_WIDTH + 1 + TIME_WIDTH,
  };
}

/**
 * What follows a name, as `ls -F` has it: `/` a directory (or a symlink to one), `@` another symlink, `|` a
 * FIFO, `=` a socket, `*` an executable.
 * @param {Entry} entry
 * @returns {string}
 */
export function marker({ type, symlink, executable }) {
  if (type === 'directory') {
    return '/';
  }
  if (symlink) {
    return '@';
  }
  return type === 'fifo' ? '|' : type === 'socket' ? '=' : executable ? '*' : '';
}

/**
 * @param {Entry} entry
 * @returns {string | null} Its color group, or `null` for a plain file.
 */
function group({ type, symlink, executable }) {
  if (symlink) {
    return type === 'unknown' ? 'pane.brokenLink' : 'pane.link';
  }
  switch (type) {
    case 'directory':
    case 'fifo':
    case 'socket':
    case 'device':
      return `pane.${type}`;
    default:
      return type === 'file' && executable ? 'pane.executable' : null;
  }
}

/**
 * A name as one line: control characters — a newline is allowed in Unix names — show as `?`, as `ls` does.
 * @param {string} name
 * @returns {string}
 */
function printable(name) {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/**
 * One entry, full width, in its type's color, over the cursor's where it is. A name too long for the row is
 * cut at the end, keeping its marker. A drive in the list of drives shows its free space as its size, and
 * no time. While anything is selected, a gutter before the name has a check on the rows selected.
 * @param {object} props
 * @param {Entry} props.entry
 * @param {number} props.width
 * @param {boolean} props.showSize
 * @param {boolean} props.showTime
 * @param {string | null} props.cursor The cursor's color group, if it's on this row.
 * @param {boolean} props.selected
 * @param {boolean} props.gutter Whether to leave room for the check.
 * @param {number} props.year This year, for the modified column.
 */
function Row({ entry, width, showSize, showTime, cursor, selected, gutter, year }) {
  const { backgroundColor, ...text } = useLineStyle([group(entry), selected ? 'pane.selected' : null, cursor]);
  const size = entry.free !== undefined ? formatSize(entry.free)
    : entry.size === null || entry.type === 'directory' ? '' : formatSize(entry.size);
  const time = entry.mtime === null || entry.free !== undefined ? '' : formatTime(entry.mtime, year);
  return (
    <Box width={width} flexShrink={0} backgroundColor={backgroundColor}>
      {gutter && <Text {...text}>{selected ? `${CHECK} ` : '  '}</Text>}
      <Box flexShrink={1}>
        <Text {...text} wrap="truncate-end">
          {printable(entry.name)}
        </Text>
      </Box>
      <Text {...text}>{marker(entry)}</Text>
      <Box flexGrow={1} />
      {showSize && (
        <Box flexShrink={0}>
          <Text {...text}>{size.padStart(1 + SIZE_WIDTH)}</Text>
        </Box>
      )}
      {showTime && (
        <Box flexShrink={0}>
          <Text {...text}>{time.padStart(1 + TIME_WIDTH)}</Text>
        </Box>
      )}
    </Box>
  );
}

/** Rows whose entry is unchanged — most, as the store shares what a change leaves alone — skip rendering. */
const MemoRow = memo(Row);

/**
 * A pane's listing (2.2): only the rows that fit are rendered, scrolled to keep the cursor in view.
 * @param {object} props
 * @param {Entry[]} props.entries
 * @param {number} props.cursor
 * @param {string[]} props.selected Names, without the group range's.
 * @param {number | null} props.range Where the group being selected starts, if one is; it ends at the
 *   cursor.
 * @param {Status} props.status
 * @param {boolean} props.active Whether the pane is active: its cursor is `pane.cursorActive`, the other's
 *   `pane.cursor`.
 * @param {(rows: number) => void} [props.onHeight] Called with the rows that fit, whenever that changes.
 */
export function Listing({ entries, cursor, selected, range, status, active, onHeight }) {
  const ref = useRef(null);
  const { width, height } = useBoxMetrics(ref);
  useEffect(() => {
    if (height > 0) {
      onHeight?.(height);
    }
  }, [height, onHeight]);
  const topRef = useRef(0);
  const top = scrollTop(topRef.current, cursor, height, entries.length);
  topRef.current = top;
  const hint = useStyle('core.hint');
  const { size: showSize, time: showTime } = columnsFor(width);
  const year = new Date().getFullYear();
  const cursorGroup = active ? 'pane.cursorActive' : 'pane.cursor';
  const names = useMemo(() => new Set(selected), [selected]);
  const gutter = names.size > 0 || range !== null;
  /** @param {number} index */
  const inRange = (index) => range !== null && index >= Math.min(range, cursor) && index <= Math.max(range, cursor);
  return (
    <Box ref={ref} flexGrow={1} flexDirection="column" overflow="hidden">
      {status === 'loading' && <Text {...hint}>Loading…</Text>}
      {status === 'ready' && entries.length === 0 && <Text {...hint}>Empty</Text>}
      {width > 0 && entries.slice(top, top + height).map((entry, i) => (
        <MemoRow
          key={entry.name}
          entry={entry}
          width={width}
          showSize={showSize}
          showTime={showTime}
          cursor={top + i === cursor ? cursorGroup : null}
          selected={names.has(entry.name) || inRange(top + i)}
          gutter={gutter}
          year={year}
        />
      ))}
    </Box>
  );
}
