import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import Vin from '../../../src/vin.js';
import Main from '../../../src/handlers/main/main.js';
import { createInProcessTransport } from '../../../src/transport.js';
import { App } from '../app.jsx';
import { connect, disconnect } from '../handler.js';
import { STRIP_DELAY } from '../common/jobs/index.js';
import { settle } from '../../../test/ui.jsx';

/**
 * The whole TUI with the main window, and a way to start jobs that run until they're cancelled or ended.
 * @param {import('node:test').TestContext} t
 */
async function setup(t) {
  const vin = new Vin();
  const main = new Main();
  vin.register(main);
  await vin.init();
  await vin.openWindow('main');
  await Promise.all([main.left.loaded, main.right.loaded]);
  vin.messages.clear();
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(<App />);
  t.after(app.unmount);
  /** @type {(() => void)[]} */
  const endings = [];
  t.after(() => endings.forEach((end) => end()));
  return {
    vin,
    /**
     * Starts a job that stops when cancelled, or when the returned function is called.
     * @param {Parameters<typeof vin.jobs.run>[0]} options
     * @param {{ done?: number }} [progress]
     */
    start(options, { done = 0 } = {}) {
      /** @type {() => void} */
      let end = () => {};
      const finished = vin.jobs.run(options, (job) => new Promise((resolve) => {
        end = () => resolve(undefined);
        job.progress({ done });
        job.signal.addEventListener('abort', () => resolve(undefined));
      }));
      endings.push(() => end());
      return { end: () => end(), finished };
    },
    /** @returns {Promise<string>} The screen, once the strip shows the jobs and the UI has caught up. */
    async frame() {
      await new Promise((resolve) => setTimeout(resolve, STRIP_DELAY));
      await settle();
      return app.lastFrame() ?? '';
    },
    /** @param {...string} input What the terminal sends, one key at a time. */
    async type(...input) {
      for (const item of input) {
        app.stdin.write(item);
        await settle();
      }
    },
  };
}

test('a running job shows above the message line: what it does, where to, and how far it is', async (t) => {
  const { start, frame } = await setup(t);
  const job = start({ mode: 'copy', name: 'notes.txt', destination: '/d/backup', items: 3, total: 200 }, { done: 90 });
  const screen = await frame();
  assert.match(screen, /│ notes\.txt ── copy ──> 1\/3 +│/);
  assert.match(screen, /│ \/d\/backup +│/);
  assert.match(screen, /│ █+░+  45% │/);
  job.end();
  await job.finished;
  assert.doesNotMatch(await frame(), /notes\.txt/);
});

test("a quick job doesn't show in the strip", async (t) => {
  const { start, frame } = await setup(t);
  const job = start({ mode: 'copy', name: 'quick.txt', destination: '/d/backup' });
  await settle();
  job.end();
  await job.finished;
  assert.doesNotMatch(await frame(), /quick\.txt/);
});

test('jobs share the strip; a deletion has no arrow, and a total not known yet shows what is done', async (t) => {
  const { start, frame } = await setup(t);
  start({ mode: 'move', name: 'a', destination: '/trash' });
  start({ mode: 'delete', name: 'b', destination: '~/x', unit: 'items', items: 4 }, { done: 2 });
  const screen = await frame();
  assert.match(screen, /│ a ── move ──> +││ b ── delete 1\/4 +│/);
  assert.match(screen, /│ ░+  0 B ││ ░+    2 │/);
});

test('t lists the jobs; d d cancels the highlighted one, and t closes the list', async (t) => {
  const { start, frame, type } = await setup(t);
  const first = start({ mode: 'copy', name: 'first.iso', destination: '/d/x', total: 10 }, { done: 5 });
  start({ mode: 'move', name: 'second', destination: '/d/y' });
  await type('t');
  let screen = await frame();
  assert.match(screen, /Jobs — 2 running/);
  assert.match(screen, /first\.iso ── copy ──> +\/d\/x +█+░+  50%/);
  assert.match(screen, /second ── move ──> +\/d\/y/);
  await type('d', 'd');
  await first.finished;
  screen = await frame();
  assert.match(screen, /Jobs — 1 running/);
  assert.match(screen, /first\.iso ── copy ──> +\/d\/x +cancelled/);
  await type('t');
  assert.doesNotMatch(await frame(), /Jobs —/);
});
