const Handler = require('../../handler');
const { isRunning } = require('../../jobs');

/**
 * The jobs window (2.10): every job (`src/jobs.js`) — running ones first, then those over, with what they
 * did — and a highlight to cancel one with. The list itself is `core`'s `jobs` state, which the UI reads;
 * this window keeps only which job is highlighted (`selected`, its id), so the highlight stays on its job
 * as others start and end.
 *
 * Keys: `j`/`k` and the arrows move, `g g`/`shift+g` jump to the ends, `d d` or Delete cancels the
 * highlighted job, and `t` or `q` closes the window, as Escape does.
 * @extends {Handler<{ selected: number | null }>}
 */
class JobList extends Handler {
  static kind = 'jobs';

  /** @type {import('../../contributions').Contributes} */
  static contributes = {
    commands: [
      { method: 'up', title: 'Highlight the previous job' },
      { method: 'down', title: 'Highlight the next job' },
      { method: 'first', title: 'Highlight the first job' },
      { method: 'last', title: 'Highlight the last job' },
      { method: 'cancel', title: 'Cancel the job', description: 'Stops the highlighted job, leaving what it has done' },
      { method: 'clear', title: 'Clear finished jobs', description: 'Drops the jobs that are over from the list' },
      { method: 'hide', title: 'Close the jobs window' },
    ],
    keybindings: [
      { key: 'up', command: 'jobs.up' },
      { key: 'k', command: 'jobs.up' },
      { key: 'down', command: 'jobs.down' },
      { key: 'j', command: 'jobs.down' },
      { key: 'home', command: 'jobs.first' },
      { key: 'g g', command: 'jobs.first' },
      { key: 'end', command: 'jobs.last' },
      { key: 'shift+g', command: 'jobs.last' },
      { key: 'd d', command: 'jobs.cancel' },
      { key: 'delete', command: 'jobs.cancel' },
      { key: 'shift+c', command: 'jobs.clear' },
      { key: 't', command: 'jobs.hide' },
      { key: 'q', command: 'jobs.hide' },
    ],
  };

  /** @type {(() => void) | null} */
  #unsubscribe = null;

  /**
   * @param {object} [options]
   * @param {string} [options.name] Its handler name. Default: `jobs`.
   */
  constructor({ name = 'jobs' } = {}) {
    super(name);
  }

  onInit() {
    this.update({ selected: this.jobs.list[0]?.id ?? null });
    this.#unsubscribe = this.jobs.subscribe(() => this.#keep());
  }

  onDispose() {
    this.#unsubscribe?.();
  }

  up() {
    this.#move(-1);
  }

  down() {
    this.#move(1);
  }

  first() {
    this.#select(this.jobs.list[0]?.id ?? null);
  }

  last() {
    this.#select(this.jobs.list.at(-1)?.id ?? null);
  }

  /** Cancels the highlighted job, if it's running. */
  cancel() {
    const job = this.jobs.list.find((info) => info.id === this.state.selected);
    if (!job || !isRunning(job)) {
      this.notify(job ? 'That job is over already' : 'No job to cancel', 'warning');
      return;
    }
    this.jobs.cancel(job.id);
  }

  /** Drops the jobs that are over. */
  clear() {
    this.jobs.clear();
  }

  /** Closes the window. */
  hide() {
    return this.close();
  }

  /** @param {number} delta */
  #move(delta) {
    const list = this.jobs.list;
    const index = list.findIndex((info) => info.id === this.state.selected);
    const next = list[Math.min(Math.max(0, index + delta), list.length - 1)];
    this.#select(next?.id ?? null);
  }

  /** Keeps the highlight on a job that's still listed — the first one, if its own is gone. */
  #keep() {
    const list = this.jobs.list;
    if (!list.some((info) => info.id === this.state.selected)) {
      this.#select(list[0]?.id ?? null);
    }
  }

  /** @param {number | null} id */
  #select(id) {
    if (id !== this.state.selected) {
      this.state.selected = id;
    }
  }
}

module.exports = JobList;
