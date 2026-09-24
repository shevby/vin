const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { paths } = require('../../paths');
const Vin = require('../../vin');
const Confirm = require('../confirm/confirm');
const Main = require('./main');
const { opener } = require('../../open');
const { tick } = require('../../../test/dialogs');

/**
 * A vin with the main window open, as `start()` opens it.
 * @param {string} [config] The config file's text.
 * @param {{ left?: string, right?: string }} [dirs] The panes' directories, as URIs. Default: ones that
 *   don't exist.
 */
async function open(config, { left = 'file:///vin-missing-a', right = 'file:///vin-missing-b' } = {}) {
  const vin = new Vin();
  const main = new Main({ left, right });
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
  assert.equal(main.left.state.uri, 'file:///vin-missing-a');
  assert.equal(main.right.state.uri, 'file:///vin-missing-b');
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

test('keys move the cursor and go into and out of directories, and back and forward', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['a', 'b', 'c']) {
    fs.mkdirSync(path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, 'b', 'f'), '');
  const { main, press } = await open(undefined, { left: paths.toUri(dir) });
  const pane = main.left;
  /**
   * Presses keys, then waits for the listing they asked for.
   * @param {string} keys
   */
  const go = async (keys) => {
    await press(keys);
    await pane.loaded;
  };
  const where = () => [paths.displayUri(pane.state.uri), pane.state.entries[pane.state.cursor]?.name];
  const home = paths.display(dir);
  await pane.loaded;
  await go('j j k');
  assert.deepEqual(where(), [home, 'b']);
  await go('l');
  assert.deepEqual(where(), [`${home}/b`, 'f']);
  await go('h');
  assert.deepEqual(where(), [home, 'b']);
  await go('shift+g');
  assert.deepEqual(where(), [home, 'c']);
  await go('g g');
  assert.deepEqual(where(), [home, 'a']);
  await go('alt+left');
  assert.deepEqual(where(), [`${home}/b`, 'f']);
  await go('alt+right');
  assert.deepEqual(where(), [home, 'a']);
  await go('~');
  assert.equal(pane.state.uri, paths.toUri(paths.home));
});

test('Enter and Right open a file; l, bound to pane.enter in the config, only enters directories', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'f'), '');
  /** @type {string[]} */
  const opened = [];
  t.mock.method(opener, 'openWithDefaultApp', async (/** @type {string} */ file) => {
    opened.push(file);
  });
  const { main, press } = await open(`{ keybindings: [{ key: 'l', command: 'pane.enter' }] }`, { left: paths.toUri(dir) });
  await main.left.loaded;
  await press('enter');
  await press('right');
  await press('l');
  assert.deepEqual(opened, [path.join(dir, 'f'), path.join(dir, 'f')]);
});

test('v selects and moves down, shift+v selects a group until v or shift+v, Escape unselects', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vin-main-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['a', 'b', 'c', 'd']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  const { main, press, focus } = await open(undefined, { left: paths.toUri(dir) });
  const pane = main.left;
  await pane.loaded;
  await press('v v');
  assert.deepEqual(pane.state.selected, ['a', 'b']);
  await press('shift+v j v');
  assert.deepEqual(pane.state.selected, ['a', 'b', 'c', 'd']);
  await press('escape');
  assert.deepEqual(pane.state.selected, []);
  await press('ctrl+a *');
  assert.deepEqual(pane.state.selected, []);
  assert.equal(focus(), 'main.left', 'Escape leaves the main window open');
});
