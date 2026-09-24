import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { render as renderInk } from 'ink';
import { render } from 'ink-testing-library';
import Vin from '../../src/vin.js';
import { createInProcessTransport } from '../../src/transport.js';
import { App } from './app.jsx';
import { connect, disconnect } from './handler.js';

test('App shows the placeholder while no window is open', async (t) => {
  const vin = new Vin();
  await vin.init();
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const { lastFrame, unmount } = render(<App />);
  t.after(unmount);
  assert.match(lastFrame() ?? '', /vin — press z z to quit/);
});

test('App exits once the backend quits', async (t) => {
  const vin = new Vin();
  await vin.init();
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  const instance = renderInk(<App />, {
    stdin: /** @type {any} */ (new PassThrough()),
    stdout: /** @type {any} */ (stdout),
    stderr: /** @type {any} */ (stdout),
    patchConsole: false,
  });
  t.after(() => instance.unmount());
  let exited = false;
  const exit = instance.waitUntilExit().then(() => {
    exited = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(exited, false);
  await vin.call('core.quit');
  await exit;
});
