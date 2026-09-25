import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { formatSize } from '../../../../src/format.js';
import { init } from '../../handler.js';
import { useSelector } from '../store/index.js';
import { useBorder, useStyle } from '../theme/index.js';

/**
 * @typedef {import('../../../../src/jobs.js').JobInfo} JobInfo
 */

/** @type {JobInfo[]} */
const NONE = [];

/** The narrowest a job's box in the strip gets, borders included. */
const BOX_WIDTH = 24;

/**
 * How long, in ms, a job runs before the strip shows it — so a quick one doesn't make the panes jump.
 */
export const STRIP_DELAY = 300;

/** Cells the percentage takes after a bar: ` 100%`. */
const PERCENT_WIDTH = 5;

/**
 * Every job, running first, from `core`'s state (`src/jobs.js`).
 * @returns {JobInfo[]}
 */
export function useJobs() {
  return useSelector(init('core').store, (state) => state.jobs ?? NONE);
}

/**
 * @param {JobInfo} job
 * @returns {boolean} Whether it's still going.
 */
export function isRunning(job) {
  return job.status === 'running' || job.status === 'asking';
}

/**
 * Cuts text to a width, marking the cut with `…` — at the end, or at the start for a path, whose end
 * says most.
 * @param {string} text
 * @param {number} width
 * @param {'end' | 'start'} [where] Default: `end`.
 * @returns {string}
 */
export function fit(text, width, where = 'end') {
  const chars = [...text];
  if (chars.length <= width) {
    return text;
  }
  if (width < 1) {
    return '';
  }
  return where === 'end' ? `${chars.slice(0, width - 1).join('')}…` : `…${chars.slice(chars.length - width + 1).join('')}`;
}

/**
 * The first line of a job: the entry it's on, then what it does — `notes.txt ── copy ──> 2/5`. A deletion
 * has no arrow, as nothing goes anywhere.
 * @param {JobInfo} job
 * @param {number} width
 * @returns {string}
 */
export function headline(job, width) {
  const count = job.items > 1 ? ` ${Math.min(job.item + 1, job.items)}/${job.items}` : '';
  const action = job.mode === 'delete' ? ` ── ${job.mode}${count}` : ` ── ${job.mode} ──>${count}`;
  return fit(job.name, Math.max(1, width - [...action].length)) + action;
}

/**
 * How far a job is: `45%`, or — until its total is known — how much it has done, `12 M`.
 * @param {JobInfo} job
 * @returns {string}
 */
function amount(job) {
  if (job.total === null) {
    return job.unit === 'bytes' ? formatSize(job.done) : String(job.done);
  }
  return `${Math.floor(fraction(job) * 100)}%`;
}

/**
 * @param {JobInfo} job
 * @returns {number} Between 0 and 1; 0 while the total is unknown.
 */
function fraction(job) {
  if (job.total === null) {
    return 0;
  }
  return job.total <= 0 ? 1 : Math.min(1, job.done / job.total);
}

/**
 * A job's progress bar, `core.progress` for the part done and `core.progressTrack` for the rest, with how
 * far it is after it — or, while it asks about a conflict, that it waits for an answer.
 * @param {object} props
 * @param {JobInfo} props.job
 * @param {number} props.width Cells, the percentage included.
 */
export function ProgressBar({ job, width }) {
  const done = useStyle('core.progress');
  const track = useStyle('core.progressTrack');
  const warning = useStyle('core.warning');
  const text = useStyle('core.window');
  if (job.status === 'asking') {
    return <Text {...warning} wrap="truncate-end">{fit('waiting for an answer', width)}</Text>;
  }
  const label = amount(job).padStart(PERCENT_WIDTH - 1);
  const bar = Math.max(0, width - [...label].length - 1);
  const filled = Math.round(fraction(job) * bar);
  return (
    <Text wrap="truncate-end">
      <Text {...done}>{'█'.repeat(filled)}</Text>
      <Text {...track}>{'░'.repeat(bar - filled)}</Text>
      <Text {...text}> {label}</Text>
    </Text>
  );
}

/**
 * One running job in the strip: what it does (`core.jobLine`), where to, and how far it is.
 * @param {object} props
 * @param {JobInfo} props.job
 * @param {number} props.width Cells, borders included.
 */
function JobBox({ job, width }) {
  const border = useBorder();
  const line = useStyle('core.jobLine');
  const hint = useStyle('core.hint');
  const inner = Math.max(1, width - 4);
  return (
    <Box borderStyle="round" {...border} paddingX={1} width={width} flexDirection="column" flexShrink={0}>
      <Text {...line} wrap="truncate-end">{headline(job, inner).padEnd(inner)}</Text>
      <Text {...hint} wrap="truncate-end">{fit(job.destination ?? '', inner, 'start')}</Text>
      <ProgressBar job={job} width={inner} />
    </Box>
  );
}

/**
 * The running jobs, above the message line, side by side — as many as fit, the rest counted in the last
 * box, which says the key that lists them all (`t`, the jobs window). A job shows once it has run for
 * `STRIP_DELAY`; nothing while none has.
 * @param {object} props
 * @param {number} props.columns The terminal's width.
 */
export function JobStrip({ columns }) {
  const running = useJobs().filter(isRunning);
  const [now, setNow] = useState(Date.now);
  const due = Math.min(...running.map((job) => job.started + STRIP_DELAY).filter((time) => time > now));
  useEffect(() => {
    if (!Number.isFinite(due)) {
      return undefined;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due]);
  const jobs = running.filter((job) => job.started + STRIP_DELAY <= now);
  const border = useBorder();
  const hint = useStyle('core.hint');
  if (!jobs.length) {
    return null;
  }
  const fitting = Math.max(1, Math.floor(columns / BOX_WIDTH));
  const shown = jobs.length <= fitting ? jobs : jobs.slice(0, Math.max(1, fitting - 1));
  const hidden = jobs.length - shown.length;
  const more = hidden ? Math.min(BOX_WIDTH, columns) : 0;
  const width = Math.floor((columns - more) / shown.length);
  return (
    <Box flexShrink={0} width={columns}>
      {shown.map((job) => (
        <JobBox key={job.id} job={job} width={width} />
      ))}
      {hidden > 0 && (
        <Box borderStyle="round" {...border} paddingX={1} width={more} flexDirection="column" flexShrink={0}>
          <Text {...hint}>+{hidden} more</Text>
          <Text {...hint}> </Text>
          <Text {...hint}>t lists them</Text>
        </Box>
      )}
    </Box>
  );
}
