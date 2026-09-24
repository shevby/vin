import { render } from 'ink-testing-library';
import Vin from '../src/vin.js';
import Handler from '../src/handler.js';
import Main from '../src/handlers/main/main.js';
import { createInProcessTransport } from '../src/transport.js';
import { App } from '../ui/tui/app.jsx';
import { connect, disconnect } from '../ui/tui/handler.js';

/** Lets the backend run and Ink render. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Renders the whole TUI over a `Vin` with the main window, opens `window` over it, and returns ways to
 * type into it and read the screen.
 * @param {import('node:test').TestContext} t
 * @param {InstanceType<typeof Handler>} window
 */
export async function renderDialog(t, window) {
  const vin = new Vin();
  const main = new Main();
  vin.register(main);
  await vin.init();
  await vin.openWindow('main');
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(<App />);
  t.after(app.unmount);
  const result = main.openWindow(window);
  await settle();
  return {
    vin,
    result,
    /** @returns {Promise<string>} The screen, once the UI has caught up. */
    async frame() {
      await settle();
      return app.lastFrame() ?? '';
    },
    /**
     * Sends what a terminal would for each item: a character, or a named key (`enter`, `escape`, `left`).
     * @param {...string} keys
     */
    async type(...keys) {
      const sequences = { enter: '\r', escape: '\x1b', left: '\x1b[D', right: '\x1b[C', down: '\x1b[B', backspace: '\x7f' };
      for (const key of keys) {
        app.stdin.write(Object.hasOwn(sequences, key) ? sequences[/** @type {keyof typeof sequences} */ (key)] : key);
        await settle();
      }
    },
  };
}
