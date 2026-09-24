import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Text, render as renderInk } from 'ink';
import { render } from 'ink-testing-library';
import Vin from '../../../../src/vin.js';
import Handler from '../../../../src/handler.js';
import { isChord } from '../../../../src/keys.js';
import { createInProcessTransport } from '../../../../src/transport.js';
import { connect, disconnect } from '../../handler.js';
import { toChord, useKeybindings } from './index.js';

/** @typedef {import('ink').Key} Key */

/** @param {Partial<Key>} flags */
const key = (flags = {}) => /** @type {Key} */ ({ ctrl: false, shift: false, meta: false, ...flags });

test('toChord turns Ink input into canonical chords', () => {
  /** @type {[string, Partial<Key>, string | null][]} */
  const cases = [
    ['j', {}, 'j'],
    ['G', { shift: true }, 'shift+g'],
    [':', {}, ':'],
    [' ', {}, 'space'],
    ['w', { ctrl: true }, 'ctrl+w'],
    ['x', { meta: true }, 'alt+x'],
    ['X', { meta: true, shift: true }, 'alt+shift+x'],
    ['', { tab: true, shift: true }, 'shift+tab'],
    ['', { return: true }, 'enter'],
    ['', { escape: true, meta: true }, 'escape'],
    ['', { upArrow: true, ctrl: true }, 'ctrl+up'],
    ['', { pageDown: true }, 'pagedown'],
    ['Ж', { shift: true }, 'shift+ж'],
    ['pasted text', {}, null],
    ['', {}, null],
  ];
  for (const [input, flags, chord] of cases) {
    const result = toChord(input, key(flags));
    assert.equal(result, chord, JSON.stringify([input, flags]));
    assert.ok(result === null || isChord(result), `${result} is canonical`);
  }
});

test('useKeybindings sends key presses to the backend', async (t) => {
  /** @type {string[]} */
  const calls = [];
  class Pane extends Handler {
    static contributes = {
      commands: [{ method: 'top', title: 'Top' }],
      keybindings: [{ key: 'shift+g', command: 'pane.top' }],
    };

    top() {
      calls.push(this.path);
    }
  }
  const vin = new Vin();
  vin.register(new Pane('pane'));
  await vin.init();
  connect(createInProcessTransport(vin));
  t.after(disconnect);

  const Window = () => {
    useKeybindings('pane');
    return <Text>pane</Text>;
  };
  const { stdin, unmount } = render(<Window />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  stdin.write('G');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['pane']);
  unmount();
});

test('useKeybindings stays inactive when stdin is not a terminal', async () => {
  // A pipe: Ink reports isRawModeSupported as stdin.isTTY, which is undefined here, not false.
  const stdin = new PassThrough();
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  const Window = () => {
    useKeybindings(null);
    return <Text>piped</Text>;
  };
  const instance = renderInk(<Window />, {
    stdin: /** @type {any} */ (stdin),
    stdout: /** @type {any} */ (stdout),
    stderr: /** @type {any} */ (stdout),
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  await instance.waitUntilExit();
});
