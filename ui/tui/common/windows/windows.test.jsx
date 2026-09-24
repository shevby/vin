import test from 'node:test';
import assert from 'node:assert/strict';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import Vin from '../../../../src/vin.js';
import Handler from '../../../../src/handler.js';
import { createInProcessTransport } from '../../../../src/transport.js';
import { connect, disconnect, init } from '../../handler.js';
import { useSelector } from '../store/index.js';
import { Windows, useFocus } from './index.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** @extends {Handler<{ question: string }>} */
class Ask extends Handler {
  static kind = 'ask';
  static contributes = {
    commands: [{ method: 'yes', title: 'Yes' }],
    keybindings: [{ key: 'y', command: 'ask.yes' }],
  };

  /** @param {string} question */
  constructor(question) {
    super('ask');
    this.question = question;
  }

  onInit() {
    this.update({ question: this.question });
  }

  yes() {
    return this.close(true);
  }
}

class Main extends Handler {
  constructor() {
    super('main');
    this.add(new Handler('left'));
    this.add(new Handler('right'));
  }
}

/** @param {{ path: string }} props */
function MainWindow({ path }) {
  const focus = useFocus();
  return (
    <Box flexDirection="column">
      {Array.from({ length: 5 }, (_, i) => (
        <Text key={i}>{'x'.repeat(40)}</Text>
      ))}
      <Text>
        {path} focus: {focus}
      </Text>
    </Box>
  );
}

/** @param {{ path: string }} props */
function AskWindow({ path }) {
  const question = useSelector(init(path).store, (state) => state.question);
  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>{question}</Text>
    </Box>
  );
}

/** @param {import('node:test').TestContext} t */
async function setup(t) {
  const vin = new Vin();
  vin.register(new Main());
  await vin.init();
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(
    <Box width={40} height={6}>
      <Windows components={{ main: MainWindow, ask: AskWindow }}>
        <Text>nothing open</Text>
      </Windows>
    </Box>,
  );
  t.after(app.unmount);
  const frame = async () => {
    await settle();
    return app.lastFrame() ?? '';
  };
  return { vin, app, frame, left: vin.resolve('main.left') };
}

test('with no window open, Windows shows its children', async (t) => {
  const { frame } = await setup(t);
  assert.match(await frame(), /nothing open/);
});

test('an overlay is drawn over the window below it, hiding what it covers', async (t) => {
  const { vin, left, frame } = await setup(t);
  await vin.openWindow('main');
  vin.resolve('main.right').focus();
  assert.match(await frame(), /main focus: main\.right/);

  left.openWindow(new Ask('Delete?'));
  const lines = (await frame()).split('\n');
  const row = lines.find((line) => line.includes('Delete?')) ?? '';
  assert.match(row, /^x+│ Delete\? │x+$/, 'blank around the text, the window below on either side');
  assert.equal(lines.filter((line) => line.startsWith('x'.repeat(40))).length, 2, 'the overlay covers three rows');
});

test('a window opened again at the same path shows its new handler, not the old one', async (t) => {
  const { vin, left, frame } = await setup(t);
  await vin.openWindow('main');
  const first = left.openWindow(new Ask('first'));
  assert.match(await frame(), /first/);

  await vin.resolve('main.left.ask').close(true);
  const second = left.openWindow(new Ask('second'));
  const shown = await frame();
  assert.match(shown, /second/);
  assert.doesNotMatch(shown, /first/);
  assert.equal(await first, true);

  await vin.call('core.press', 'y');
  assert.equal(await second, true);
  assert.doesNotMatch(await frame(), /second/);
});

test('a window of a kind with no component gets a placeholder', async (t) => {
  const { vin, frame } = await setup(t);
  class Unknown extends Handler {}
  vin.register(new Unknown('mystery'));
  await vin.openWindow('mystery');
  assert.match(await frame(), /No TUI for window "mystery"\s+│\n│ \(mystery\)/, 'wrapped at 40 columns');
});
