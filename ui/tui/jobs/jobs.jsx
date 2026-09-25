import { Box, Text, useWindowSize } from 'ink';
import { init } from '../handler.js';
import { fit, headline, isRunning, ProgressBar, useJobs } from '../common/jobs/index.js';
import { useSelector } from '../common/store/index.js';
import { useBorder, useStyle } from '../common/theme/index.js';

/**
 * @typedef {import('../../../src/jobs.js').JobInfo} JobInfo
 */

/** Rows the window keeps for its border, title, footer, and the gaps between them. */
const CHROME = 8;

/** The widest the window gets. */
const MAX_WIDTH = 120;

/**
 * The jobs window (`src/handlers/jobs/`): every job from `core`'s state, running ones first — what it
 * does, where to, and its progress bar, or how it ended — the highlighted one in `core.highlight`. A list
 * taller than the screen scrolls with the highlight.
 * @param {{ path: string }} props
 */
export function Jobs({ path }) {
  const { columns, rows } = useWindowSize();
  const selected = useSelector(init(path).store, (state) => /** @type {number | null} */ (state.selected ?? null));
  const jobs = useJobs();
  const border = useBorder();
  const heading = useStyle('core.title');
  const hint = useStyle('core.hint');
  const width = Math.min(MAX_WIDTH, Math.max(30, columns - 8));
  const inner = width - 4;
  const room = Math.max(1, rows - CHROME);
  const index = Math.max(0, jobs.findIndex((job) => job.id === selected));
  const start = Math.min(Math.max(0, index - room + 1), Math.max(0, jobs.length - room));
  const running = jobs.filter(isRunning).length;
  return (
    <Box borderStyle="round" {...border} flexDirection="column" paddingX={1} width={width}>
      <Text {...heading}>Jobs{running ? ` — ${running} running` : ''}</Text>
      <Box flexDirection="column" marginY={1}>
        {jobs.length ? (
          jobs.slice(start, start + room).map((job) => <Row key={job.id} job={job} width={inner} highlighted={job.id === selected} />)
        ) : (
          <Text {...hint}>No jobs: copies, moves and deletions show here while they run</Text>
        )}
      </Box>
      <Text {...hint} wrap="truncate-end">
        d d cancels · shift+c clears the finished · t closes
      </Text>
    </Box>
  );
}

/**
 * One job: its headline, where it goes, and its progress — or how it ended.
 * @param {object} props
 * @param {JobInfo} props.job
 * @param {number} props.width
 * @param {boolean} props.highlighted
 */
function Row({ job, width, highlighted }) {
  const text = useStyle('core.window');
  const highlight = useStyle('core.highlight');
  const hint = useStyle('core.hint');
  const error = useStyle('core.error');
  const warning = useStyle('core.warning');
  const left = Math.max(10, Math.floor(width * 0.4));
  const middle = Math.max(8, Math.floor(width * 0.3));
  const right = Math.max(8, width - left - middle - 2);
  // What a job that's over shows before its summary, unless it went well.
  const ending = isRunning(job) ? null : job.status;
  const endingStyle = job.status === 'failed' ? error : job.status === 'cancelled' ? warning : hint;
  return (
    <Box width={width}>
      <Box width={left} flexShrink={0}>
        <Text {...(highlighted ? highlight : text)} wrap="truncate-end">
          {headline(job, left).padEnd(left)}
        </Text>
      </Box>
      <Box width={middle} flexShrink={0} marginLeft={1}>
        <Text {...hint} wrap="truncate-end">
          {fit(job.destination ?? '', middle, 'start')}
        </Text>
      </Box>
      <Box width={right} flexShrink={0} marginLeft={1}>
        {ending ? (
          <Text {...endingStyle} wrap="truncate-end">
            {fit(job.summary && job.status !== 'done' ? `${ending}: ${job.summary}` : job.summary ?? ending, right)}
          </Text>
        ) : (
          <ProgressBar job={job} width={right} />
        )}
      </Box>
    </Box>
  );
}
