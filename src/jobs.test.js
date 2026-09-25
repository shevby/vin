const test = require('node:test');
const assert = require('node:assert/strict');
const { Jobs, PROGRESS_INTERVAL } = require('./jobs');

/**
 * A job's work that runs until `finish` is called — or it's cancelled, when it throws an abort.
 * @returns {{ work: (job: import('./jobs').JobControl) => Promise<string>, finish: (result: string) => void, control: () => import('./jobs').JobControl }}
 */
function pending() {
  /** @type {(result: string) => void} */
  let finish = () => {};
  /** @type {import('./jobs').JobControl | null} */
  let control = null;
  return {
    work: (job) => {
      control = job;
      return new Promise((resolve, reject) => {
        finish = resolve;
        job.signal.addEventListener('abort', () => reject(job.signal.reason));
      });
    },
    finish: (result) => finish(result),
    control: () => /** @type {import('./jobs').JobControl} */ (control),
  };
}

test('a job is listed while it runs, and settles as its work does', async () => {
  const jobs = new Jobs();
  const { work, finish, control } = pending();
  const result = jobs.run({ mode: 'copy', name: 'a', destination: '/d', items: 2 }, work);
  assert.equal(jobs.running, 1);
  assert.deepEqual({ ...jobs.list[0], started: 0 }, {
    id: 1, mode: 'copy', name: 'a', destination: '/d', item: 0, items: 2, unit: 'bytes', done: 0, total: null, status: 'running', summary: null, started: 0,
  });
  control().end('Copied 2 items');
  finish('ok');
  assert.equal(await result, 'ok');
  assert.equal(jobs.running, 0);
  assert.deepEqual([jobs.list[0].status, jobs.list[0].summary], ['done', 'Copied 2 items']);
});

test('progress is shown at most every PROGRESS_INTERVAL ms; a change of status at once', async () => {
  const jobs = new Jobs();
  let calls = 0;
  jobs.subscribe(() => calls++);
  const { work, finish, control } = pending();
  const result = jobs.run({ mode: 'copy' }, work);
  assert.equal(calls, 1, 'started');
  control().progress({ done: 1 });
  control().progress({ done: 2, total: 10 });
  assert.equal(calls, 1);
  await new Promise((resolve) => setTimeout(resolve, PROGRESS_INTERVAL + 20));
  assert.equal(calls, 2);
  assert.deepEqual([jobs.list[0].done, jobs.list[0].total], [2, 10]);
  const answer = control().ask(async () => {
    assert.equal(jobs.list[0].status, 'asking');
    return 'skip';
  });
  assert.equal(await answer, 'skip');
  assert.equal(jobs.list[0].status, 'running');
  finish('');
  await result;
  assert.equal(jobs.list[0].status, 'done');
});

test('a cancelled job ends as cancelled, its abort returned as undefined; cancelAll waits for all', async () => {
  const jobs = new Jobs();
  const one = pending();
  const two = pending();
  const first = jobs.run({ mode: 'copy' }, one.work);
  const second = jobs.run({ mode: 'move' }, two.work);
  assert.equal(jobs.cancel(1), true);
  assert.equal(await first, undefined);
  assert.equal(jobs.list.find((job) => job.id === 1)?.status, 'cancelled');
  assert.equal(jobs.cancel(1), false, 'over already');
  await jobs.cancelAll();
  assert.equal(await second, undefined);
  assert.deepEqual(jobs.list.map((job) => job.status), ['cancelled', 'cancelled']);
});

test('a job whose work throws fails, and so does one that ends saying some of it failed', async () => {
  const jobs = new Jobs();
  await assert.rejects(jobs.run({ mode: 'delete' }, async () => {
    throw new Error('broken');
  }), /broken/);
  await jobs.run({ mode: 'copy' }, async (job) => job.end('Copied 1 of 2 items', true));
  assert.deepEqual(jobs.list.map((job) => [job.status, job.summary]), [['failed', 'broken'], ['failed', 'Copied 1 of 2 items']]);
});

test('running jobs are listed first; clear drops the ones over, and only the latest 20 are kept', async () => {
  const jobs = new Jobs();
  await jobs.run({ mode: 'copy', name: 'over' }, async () => {});
  const { work, finish } = pending();
  const running = jobs.run({ mode: 'move', name: 'running' }, work);
  assert.deepEqual(jobs.list.map((job) => job.name), ['running', 'over']);
  for (let i = 0; i < 25; i++) {
    await jobs.run({ mode: 'copy', name: String(i) }, async () => {});
  }
  assert.equal(jobs.list.length, 21);
  assert.deepEqual(jobs.list.slice(0, 2).map((job) => job.name), ['running', '5']);
  jobs.clear();
  assert.deepEqual(jobs.list.map((job) => job.name), ['running']);
  finish('');
  await running;
});
