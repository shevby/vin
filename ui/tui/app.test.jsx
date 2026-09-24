import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { App } from './app.jsx';

test('App renders the placeholder text', () => {
  const { lastFrame, unmount } = render(<App />);
  assert.match(lastFrame() ?? '', /vin — press Ctrl\+C to quit/);
  unmount();
});
