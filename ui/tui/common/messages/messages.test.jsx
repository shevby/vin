import test from 'node:test';
import assert from 'node:assert/strict';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import Vin from '../../../../src/vin.js';
import Handler from '../../../../src/handler.js';
import { createInProcessTransport } from '../../../../src/transport.js';
import { App } from '../../app.jsx';
import { connect, disconnect } from '../../handler.js';
import { needsPopup } from './index.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** @param {import('node:test').TestContext} t */
async function setup(t) {
  /** @type {string[]} */
  const calls = [];
  class Pane extends Handler {
    static contributes = {
      commands: [{ method: 'down', title: 'Down' }],
      keybindings: [{ key: 'j', command: 'pane.down' }],
    };

    down() {
      calls.push('down');
    }
  }
  const vin = new Vin();
  vin.register(new Pane('pane'));
  await vin.init();
  await vin.openWindow('pane');
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(<App components={{ pane: () => <Text>pane window</Text> }} />);
  t.after(app.unmount);
  const frame = async () => {
    await settle();
    return app.lastFrame() ?? '';
  };
  return { vin, calls, stdin: app.stdin, frame };
}

test('one short message goes on the bottom line until the next key, which still does its job', async (t) => {
  const { vin, calls, stdin, frame } = await setup(t);
  vin.messages.show('Permission denied: ~/x', 'error');
  vin.messages.show('Permission denied: ~/x', 'error');
  const lines = (await frame()).split('\n');
  assert.equal(lines.at(-1)?.trim(), 'Permission denied: ~/x (×2)');
  assert.match(lines.join('\n'), /pane window/);

  stdin.write('j');
  assert.doesNotMatch(await frame(), /Permission denied/);
  assert.deepEqual(calls, ['down']);
});

test('several messages, or one too long for the line, open a popup that a key only dismisses', async (t) => {
  const { vin, calls, stdin, frame } = await setup(t);
  vin.messages.show('Deleting failed', 'error');
  vin.messages.show('Some files were skipped', 'warning');
  const popup = await frame();
  assert.match(popup, /2 messages[\s\S]*Deleting failed[\s\S]*Some files were skipped[\s\S]*Press any key/);

  stdin.write('j');
  assert.doesNotMatch(await frame(), /Deleting failed|Press any key/);
  assert.deepEqual(calls, [], 'the key only dismissed the popup');

  vin.messages.show(`Unexpected error: ${'x'.repeat(120)}`, 'error');
  assert.match(await frame(), /Error[\s\S]*Unexpected error: x+[\s\S]*Press any key/);
});

test('needsPopup: more than one message, a line break, or more than the width', () => {
  /** @param {string} text */
  const one = (text, count = 1) => [{ id: 1, level: /** @type {const} */ ('info'), text, count }];
  assert.equal(needsPopup([], 10), false);
  assert.equal(needsPopup(one('0123456789'), 10), false);
  assert.equal(needsPopup(one('0123456789', 2), 10), true, 'the count takes room too');
  assert.equal(needsPopup(one('01234567890'), 10), true);
  assert.equal(needsPopup(one('a\nb'), 10), true);
  assert.equal(needsPopup([...one('a'), ...one('b')], 10), true);
});
