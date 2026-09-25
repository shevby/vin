/**
 * Long operations as background jobs (2.10) — copying, moving, deleting — with progress and cancel. A job
 * is started by whoever runs the operation (a pane), which awaits it as before; the key that started it
 * doesn't wait (`core.press`), so vin keeps taking keys meanwhile. `core` mirrors the jobs in its state
 * (`jobs`), where the TUI shows the running ones above the message line and all of them in the jobs window
 * (`src/handlers/jobs/`).
 */

/**
 * What a job does, as it's shown: `copy ──>`, `delete`.
 * @typedef {'copy' | 'move' | 'link' | 'delete' | 'restore'} JobMode
 */

/**
 * `asking` while it waits for an answer about a conflict; `failed` when it ended with errors — those are
 * reported as messages.
 * @typedef {'running' | 'asking' | 'done' | 'failed' | 'cancelled'} JobStatus
 */

/**
 * One job, as `core` has it in `state.jobs`.
 * @typedef {object} JobInfo
 * @property {number} id Increasing.
 * @property {JobMode} mode
 * @property {string} name The entry it's on now — a top-level one, of those it was given.
 * @property {string | null} destination Where entries go, shown (`/c/Users/me`); for a deletion, where
 *   they are.
 * @property {number} item Entries done — top-level ones.
 * @property {number} items Entries it was given.
 * @property {'bytes' | 'items'} unit What `done` and `total` count.
 * @property {number} done
 * @property {number | null} total `null` until it's known — sizes are added up while the job runs.
 * @property {JobStatus} status
 * @property {string | null} summary What it did, once it's over (`Copied 3 items, skipped 1`).
 * @property {number} started In ms since the epoch.
 */

/**
 * What a job's work gets: its `signal`, aborted when it's cancelled, and a way to tell how it's going.
 * @typedef {object} JobControl
 * @property {AbortSignal} signal
 * @property {(changes: Partial<Pick<JobInfo, 'name' | 'destination' | 'item' | 'items' | 'done' | 'total'>>) => void} progress
 *   Shown at most every `PROGRESS_INTERVAL` ms.
 * @property {<T>(question: () => Promise<T>) => Promise<T>} ask Runs a question to the user, the job
 *   `asking` meanwhile.
 * @property {(summary: string, failed?: boolean) => void} end What it did, before it returns; `failed`
 *   if some of it failed.
 */

/** How often, in ms, progress is shown at most. */
const PROGRESS_INTERVAL = 100;

/** Jobs that are over kept in the list, the latest ones. */
const FINISHED_KEPT = 20;

/** The code of the error a cancelled job's work may end with. */
const ABORTED = 'ABORT_ERR';

/**
 * Whether an error is a job's work giving up because it was cancelled.
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbort(error) {
  return error instanceof Error && (error.name === 'AbortError' || /** @type {NodeJS.ErrnoException} */ (error).code === ABORTED);
}

/**
 * The jobs, running and recently over — one set per `Vin`; handlers reach it as `this.jobs`.
 */
class Jobs {
  /** @type {{ info: JobInfo, controller: AbortController, over: Promise<unknown> }[]} */
  #jobs = [];
  #lastId = 0;
  /** @type {Set<() => void>} */
  #listeners = new Set();
  /** @type {NodeJS.Timeout | null} */
  #timer = null;

  /**
   * Every job, running first, then those over — each part oldest first; copies.
   * @returns {JobInfo[]}
   */
  get list() {
    const infos = this.#jobs.map(({ info }) => ({ ...info }));
    const over = (/** @type {JobInfo} */ info) => !isRunning(info);
    return [...infos.filter((info) => !over(info)), ...infos.filter(over)];
  }

  /** How many are running. */
  get running() {
    return this.#jobs.filter(({ info }) => isRunning(info)).length;
  }

  /**
   * Runs `work` as a job, and settles as it does. If it's cancelled, `work` should stop soon, and return
   * or throw an abort (`signal.throwIfAborted()`); an abort is returned as `undefined`.
   * @template T
   * @param {Pick<JobInfo, 'mode'> & Partial<Pick<JobInfo, 'name' | 'destination' | 'items' | 'unit' | 'total'>>} options
   * @param {(job: JobControl) => Promise<T>} work
   * @returns {Promise<T | undefined>}
   */
  async run({ mode, name = '', destination = null, items = 1, unit = 'bytes', total = null }, work) {
    /** @type {JobInfo} */
    const info = { id: ++this.#lastId, mode, name, destination, item: 0, items, unit, done: 0, total, status: 'running', summary: null, started: Date.now() };
    const controller = new AbortController();
    /** @type {() => void} */
    let settle = () => {};
    const job = { info, controller, over: new Promise((resolve) => { settle = () => resolve(undefined); }) };
    this.#jobs.push(job);
    this.#notify();
    let asking = 0;
    let failed = false;
    /** @type {JobControl} */
    const control = {
      signal: controller.signal,
      progress: (changes) => {
        Object.assign(info, changes);
        this.#later();
      },
      ask: async (question) => {
        asking++;
        this.#status(info, 'asking');
        try {
          return await question();
        } finally {
          if (--asking === 0 && info.status === 'asking') {
            this.#status(info, 'running');
          }
        }
      },
      end: (summary, someFailed = false) => {
        info.summary = summary;
        failed = someFailed;
      },
    };
    try {
      const result = await work(control);
      this.#finish(info, controller.signal.aborted ? 'cancelled' : failed ? 'failed' : 'done');
      return result;
    } catch (error) {
      if (controller.signal.aborted && isAbort(error)) {
        this.#finish(info, 'cancelled');
        return undefined;
      }
      info.summary ??= error instanceof Error ? error.message : String(error);
      this.#finish(info, 'failed');
      throw error;
    } finally {
      settle();
    }
  }

  /**
   * Cancels a running job: its work is told to stop, and ends soon after.
   * @param {number} id
   * @returns {boolean} Whether it was running.
   */
  cancel(id) {
    const job = this.#jobs.find(({ info }) => info.id === id);
    if (!job || !isRunning(job.info) || job.controller.signal.aborted) {
      return false;
    }
    job.controller.abort();
    return true;
  }

  /**
   * Cancels every running job.
   * @returns {Promise<void>} Settles once they've all stopped.
   */
  async cancelAll() {
    const running = this.#jobs.filter(({ info }) => isRunning(info));
    for (const { info } of running) {
      this.cancel(info.id);
    }
    await Promise.all(running.map(({ over }) => over));
  }

  /** Drops the jobs that are over from the list. */
  clear() {
    const before = this.#jobs.length;
    this.#jobs = this.#jobs.filter(({ info }) => isRunning(info));
    if (this.#jobs.length !== before) {
      this.#notify();
    }
  }

  /**
   * Calls `listener` whenever the list changes — progress at most every `PROGRESS_INTERVAL` ms.
   * @param {() => void} listener
   * @returns {() => void} Stops calling it.
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * @param {JobInfo} info
   * @param {JobStatus} status
   */
  #status(info, status) {
    info.status = status;
    this.#notify();
  }

  /**
   * @param {JobInfo} info
   * @param {JobStatus} status
   */
  #finish(info, status) {
    info.status = status;
    const over = this.#jobs.filter((job) => !isRunning(job.info));
    for (const job of over.slice(0, Math.max(0, over.length - FINISHED_KEPT))) {
      this.#jobs.splice(this.#jobs.indexOf(job), 1);
    }
    this.#notify();
  }

  /** Tells the listeners soon — progress, which comes often. */
  #later() {
    if (this.#timer) {
      return;
    }
    this.#timer = setTimeout(() => this.#notify(), PROGRESS_INTERVAL);
    this.#timer.unref();
  }

  /** Tells the listeners now. */
  #notify() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * @param {JobInfo} info
 * @returns {boolean} Whether the job is still going.
 */
function isRunning(info) {
  return info.status === 'running' || info.status === 'asking';
}

/**
 * An error for work that stops because it was cancelled.
 * @returns {Error}
 */
function aborted() {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError', code: ABORTED });
}

module.exports = { Jobs, isRunning, isAbort, aborted, PROGRESS_INTERVAL };
