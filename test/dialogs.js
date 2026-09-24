const Vin = require('../src/vin');
const Handler = require('../src/handler');

/** Lets queued microtasks and immediates run: state patches, commands started by keys. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Opens `window` over a main window in a fresh `Vin`, for driving it with keys as the UI would.
 * @template {InstanceType<typeof Handler>} W
 * @param {W} window
 */
async function openOverMain(window) {
  const vin = new Vin();
  const main = new Handler('main');
  vin.register(main);
  await vin.init();
  await vin.openWindow('main');
  let settled = false;
  /** @type {Promise<unknown>} */
  const result = main.openWindow(window).finally(() => {
    settled = true;
  });
  await tick();
  return {
    vin,
    window,
    result,
    /** Whether the window has closed. */
    closed: () => settled,
    /**
     * Presses keys, one chord per space-separated item (`'h e l l o enter'`), letting each command run.
     * @param {string} keys
     */
    async press(keys) {
      for (const chord of keys.split(' ')) {
        await vin.call('core.press', chord);
        await tick();
      }
    },
    /**
     * Pastes text, as the UI does with `core.type`.
     * @param {string} text
     */
    async paste(text) {
      const taken = await vin.call('core.type', text);
      await tick();
      return taken;
    },
    focus: () => vin.windows.focused?.path ?? null,
  };
}

module.exports = { openOverMain, tick };
