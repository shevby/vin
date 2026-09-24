import test from 'node:test';
import assert from 'node:assert/strict';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import Vin from '../../../../src/vin.js';
import Main from '../../../../src/handlers/main/main.js';
import { createInProcessTransport } from '../../../../src/transport.js';
import { App } from '../../app.jsx';
import { connect, disconnect } from '../../handler.js';
import { settle } from '../../../../test/ui.jsx';
import { inkColor, lineStyle, textStyle } from './index.js';

test('colors become what Ink takes; text without a color of its own takes the window\'s', () => {
  assert.equal(inkColor(149), 'ansi256(149)');
  assert.equal(inkColor('#afd75f'), '#afd75f');
  assert.equal(inkColor('blue'), 'blue');
  assert.equal(inkColor('default'), undefined);
  const window = { fg: 252, bg: 234 };
  assert.deepEqual(textStyle({ bold: true, inverse: true }, window), { color: 'ansi256(252)', bold: true, inverse: true });
  assert.deepEqual(textStyle({ fg: 234, bg: 149 }, window), { color: 'ansi256(234)', backgroundColor: 'ansi256(149)' });
  assert.deepEqual(textStyle(undefined, undefined), {}, 'no scheme: the terminal\'s colors');
});

test('a line\'s style merges groups and resolves inverse into swapped colors', () => {
  const window = { fg: 252, bg: 234 };
  const directory = { fg: 74, bold: true };
  assert.deepEqual(lineStyle([directory, { bold: true, inverse: true }], window),
    { color: 'ansi256(234)', backgroundColor: 'ansi256(74)', bold: true });
  assert.deepEqual(lineStyle([undefined, { bold: true, inverse: true }], window),
    { color: 'ansi256(234)', backgroundColor: 'ansi256(252)', bold: true }, 'the window\'s colors, swapped');
  assert.deepEqual(lineStyle([directory, { bold: true, bg: 235 }], window),
    { color: 'ansi256(74)', backgroundColor: 'ansi256(235)', bold: true });
  assert.deepEqual(lineStyle([undefined, undefined], window), { color: 'ansi256(252)' });
});

test('the TUI draws in the scheme, with the user\'s changes', async (t) => {
  const level = chalk.level;
  // 256 colors, so the frame keeps them; tests otherwise run without any.
  chalk.level = 2;
  t.after(() => {
    chalk.level = level;
  });
  const vin = new Vin();
  vin.register(new Main());
  vin.config.parse('{ colors: { pane: { title: { fg: 33 } } } }', 'config.json5');
  await vin.init();
  vin.config.check();
  await vin.openWindow('main');
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(<App />);
  t.after(app.unmount);
  await settle();
  const top = (app.lastFrame() ?? '').split('\n')[0];
  // The codes each pane's title is drawn with, in any order.
  const titles = [...top.matchAll(/((?:\x1b\[[\d;]+m)+) [^\x1b ]+ /g)].map(([, codes]) => new Set(codes.match(/\x1b\[[\d;]+m/g)));
  assert.equal(titles.length, 2);
  assert.deepEqual(titles[0], new Set(['\x1b[1m', '\x1b[48;5;149m', '\x1b[38;5;234m']), "the active one: papercolor-dark's TopLineSel");
  assert.deepEqual(titles[1], new Set(['\x1b[1m', '\x1b[48;5;235m', '\x1b[38;5;33m']), "the other: TopLine, with the user's color");
  assert.ok(top.startsWith('\x1b[48;5;234m\x1b[38;5;252m╭'), "borders: Border, on Win's background");
});
