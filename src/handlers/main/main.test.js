const test = require('node:test');
const assert = require('node:assert/strict');
const Vin = require('../../vin');
const Confirm = require('../confirm/confirm');
const Main = require('./main');
const { tick } = require('../../../test/dialogs');

/**
 * A vin with the main window open, as `start()` opens it.
 * @param {string} [config] The config file's text.
 */
async function open(config) {
  const vin = new Vin();
  const main = new Main({ left: 'file:///a', right: 'file:///b' });
  vin.register(main);
  if (config !== undefined) {
    vin.config.parse(config, 'config.json5');
  }
  await vin.init();
  vin.config.check();
  await vin.openWindow('main');
  return {
    vin,
    main,
    /**
     * Presses keys, one chord per space-separated item, letting each command run.
     * @param {string} keys
     */
    async press(keys) {
      for (const chord of keys.split(' ')) {
        await vin.call('core.press', chord);
        await tick();
      }
    },
    focus: () => vin.windows.focused?.path ?? null,
  };
}

test('the main window opens with two panes, the left one active and focused', async () => {
  const { main, focus } = await open();
  assert.deepEqual(main.state, { active: 'left', singlePane: false });
  assert.deepEqual(main.left.state, { uri: 'file:///a' });
  assert.deepEqual(main.right.state, { uri: 'file:///b' });
  assert.equal(focus(), 'main.left');
});

test('Tab and ctrl+w switch the active pane', async () => {
  const { main, press, focus } = await open();
  await press('tab');
  assert.equal(main.state.active, 'right');
  assert.equal(focus(), 'main.right');
  await press('ctrl+w w');
  assert.equal(focus(), 'main.left');
  await press('ctrl+w ctrl+w ctrl+w h');
  assert.equal(focus(), 'main.left');
  await press('ctrl+w l');
  assert.deepEqual([main.state.active, focus()], ['right', 'main.right']);
  await assert.rejects(main.call('activate', 'middle'), /Expected "left" or "right", got "middle"/);
});

test('ctrl+w o shows one pane and ctrl+w v both; Tab swaps which one is shown', async () => {
  const { main, press, focus } = await open();
  await press('ctrl+w o');
  assert.deepEqual(main.state, { active: 'left', singlePane: true });
  await press('tab');
  assert.deepEqual(main.state, { active: 'right', singlePane: true });
  assert.equal(focus(), 'main.right');
  await press('ctrl+w v');
  assert.deepEqual(main.state, { active: 'right', singlePane: false });
});

test('main.singlePane in the config starts vin with one pane', async () => {
  const { main } = await open('{ main: { singlePane: true } }');
  assert.equal(main.state.singlePane, true);
});

test('a dialog over the main window gets the keys; the focus comes back to the active pane', async () => {
  const { main, press, focus } = await open();
  await press('tab');
  const answer = main.right.openWindow(new Confirm({ message: 'Sure?' }));
  await tick();
  await press('tab');
  assert.equal(main.state.active, 'right', "Tab toggles the dialog's buttons instead");
  await press('escape');
  assert.equal(await answer, null);
  assert.equal(focus(), 'main.right');
});
