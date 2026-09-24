import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.match(lastFrame() ?? '', /vin — press Ctrl\+C to quit/);
});
