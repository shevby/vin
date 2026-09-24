import test from 'node:test';
import assert from 'node:assert/strict';
import nodePath from 'node:path';
import { render } from 'ink-testing-library';
import Vin from '../../../src/vin.js';
import Main from '../../../src/handlers/main/main.js';
import { paths } from '../../../src/paths.js';
import { createInProcessTransport } from '../../../src/transport.js';
import { App } from '../app.jsx';
import { connect, disconnect } from '../handler.js';
import { settle } from '../../../test/ui.jsx';

/** @param {...string} names Under the home directory. */
const home = (...names) => paths.toUri(nodePath.join(paths.home, ...names));

/**
 * The whole TUI, 100 columns wide, with the main window open.
 * @param {import('node:test').TestContext} t
 * @param {{ left?: string, right?: string }} panes
 */
async function setup(t, panes) {
  const vin = new Vin();
  const main = new Main(panes);
  vin.register(main);
  await vin.init();
  await vin.openWindow('main');
  // The directories don't exist: drop the errors, so the first key isn't taken to dismiss them.
  await Promise.all([main.left.loaded, main.right.loaded]);
  vin.messages.clear();
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(<App />);
  t.after(app.unmount);
  return {
    vin,
    /** @returns {Promise<string>} The screen's top line, once the UI has caught up. */
    async top() {
      await settle();
      return (app.lastFrame() ?? '').split('\n')[0];
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

const TAB = '\t';
const CTRL_W = '\x17';

test('the panes share the width, each with its directory in its top border', async (t) => {
  const { top } = await setup(t, { left: home('a'), right: home('b') });
  const line = await top();
  assert.match(line, /^╭─ ~\/a ─+╮╭─ ~\/b ─+╮$/);
  assert.equal(line.indexOf('╭', 1), 50);
});

test('a path too long for its pane is cut from the start', async (t) => {
  const long = ['projects', 'a'.repeat(30), 'b'.repeat(30), 'deep'];
  const { top, type } = await setup(t, { left: home(...long), right: home('b') });
  assert.match(await top(), /^╭─ …a+\/b{30}\/deep ─╮╭─ ~\/b ─+╮$/);
  await type(CTRL_W, 'o');
  assert.match(await top(), /^╭─ ~\/projects\/a{30}\/b{30}\/deep ─+╮$/, 'it fits in one pane, full width');
});

test('single-pane mode shows the active pane; Tab swaps it', async (t) => {
  const { vin, top, type } = await setup(t, { left: home('a'), right: home('b') });
  await type(CTRL_W, 'o');
  assert.match(await top(), /^╭─ ~\/a ─+╮$/);
  await type(TAB);
  assert.match(await top(), /^╭─ ~\/b ─+╮$/);
  assert.equal(vin.windows.focused?.path, 'main.right');
  await type(CTRL_W, 'v');
  assert.match(await top(), /^╭─ ~\/a ─+╮╭─ ~\/b ─+╮$/);
});
