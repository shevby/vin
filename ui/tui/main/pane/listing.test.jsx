import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import Vin from '../../../../src/vin.js';
import Main from '../../../../src/handlers/main/main.js';
import { paths } from '../../../../src/paths.js';
import { createInProcessTransport } from '../../../../src/transport.js';
import { App } from '../../app.jsx';
import { connect, disconnect } from '../../handler.js';
import { settle } from '../../../../test/ui.jsx';
import { columnsFor, marker, scrollTop } from './listing.jsx';
import { selectionCount } from './pane.jsx';

/**
 * A temp directory, removed after the test.
 * @param {import('node:test').TestContext} t
 * @param {{ [name: string]: string | null }} files A file with that text, or a directory for `null`.
 */
function tempDir(t, files) {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'vin-listing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    if (text === null) {
      fs.mkdirSync(nodePath.join(dir, name));
    } else {
      fs.writeFileSync(nodePath.join(dir, name), text);
    }
  }
  return dir;
}

/**
 * The whole TUI, 100 columns wide, with both panes on `left` and `right`, listed.
 * @param {import('node:test').TestContext} t
 * @param {string} left
 * @param {string} [right]
 */
async function setup(t, left, right = left) {
  const vin = new Vin();
  const main = new Main({ left: paths.toUri(left), right: paths.toUri(right) });
  vin.register(main);
  await vin.init();
  await vin.openWindow('main');
  await Promise.all([main.left.loaded, main.right.loaded]);
  connect(createInProcessTransport(vin));
  t.after(disconnect);
  const app = render(<App />);
  t.after(app.unmount);
  return {
    main,
    /** @returns {Promise<string[]>} The screen's lines, once the UI has caught up. */
    async lines() {
      await settle();
      return (app.lastFrame() ?? '').split('\n');
    },
  };
}

test('scrollTop moves the window only as far as keeps the cursor in view', () => {
  assert.equal(scrollTop(0, 0, 10, 100), 0);
  assert.equal(scrollTop(0, 9, 10, 100), 0);
  assert.equal(scrollTop(0, 10, 10, 100), 1, 'one past the bottom scrolls one row');
  assert.equal(scrollTop(20, 15, 10, 100), 15, 'above the top scrolls up to it');
  assert.equal(scrollTop(20, 25, 10, 100), 20, 'in view: stays');
  assert.equal(scrollTop(95, 99, 10, 100), 90, 'no empty rows below the last entry');
  assert.equal(scrollTop(5, 2, 10, 4), 0, 'fewer entries than rows');
  assert.equal(scrollTop(5, 2, 0, 4), 0, 'not measured yet');
});

test('narrow panes drop the modified column, then the size one', () => {
  assert.deepEqual(columnsFor(48), { size: true, time: true });
  assert.deepEqual(columnsFor(30), { size: true, time: false });
  assert.deepEqual(columnsFor(18), { size: false, time: false });
});

test('markers follow ls -F', () => {
  /** @param {Partial<import('../../../../src/handlers/main/pane/pane.js').Entry>} fields */
  const entry = (fields) => ({ name: 'x', type: /** @type {const} */ ('file'), symlink: false, executable: false, size: null, mtime: null, hidden: false, ...fields });
  assert.equal(marker(entry({})), '');
  assert.equal(marker(entry({ type: 'directory' })), '/');
  assert.equal(marker(entry({ type: 'directory', symlink: true })), '/');
  assert.equal(marker(entry({ symlink: true })), '@');
  assert.equal(marker(entry({ type: 'unknown', symlink: true })), '@');
  assert.equal(marker(entry({ executable: true })), '*');
  assert.equal(marker(entry({ type: 'fifo' })), '|');
  assert.equal(marker(entry({ type: 'socket' })), '=');
  assert.equal(marker(entry({ type: 'device' })), '');
});

test('a pane lists names with markers, sizes and times; a long name is cut, keeping its marker', async (t) => {
  const dir = tempDir(t, { src: null, ['n'.repeat(60)]: null, 'README.md': 'x'.repeat(4300), 'run.cmd': '' });
  const year = new Date().getFullYear();
  const { lines } = await setup(t, dir);
  const rows = (await lines()).slice(1, 5).map((line) => line.slice(1, 49));
  const time = String.raw`\w{3} [ \d]\d (\d\d:\d\d|  ${year})`;
  assert.match(rows[0], new RegExp(String.raw`^n{26}…/ +${time}$`), 'the long name, cut');
  assert.match(rows[1], new RegExp(String.raw`^src/ +${time}$`));
  assert.match(rows[2], new RegExp(String.raw`^README\.md +4\.2 K ${time}$`));
  if (process.platform === 'win32') {
    assert.match(rows[3], /^run\.cmd\* +0 B /, 'executable by extension');
  }
  assert.ok(rows.every((row) => row.length === 48));
});

test('only the rows that fit are rendered, in an empty pane a hint', async (t) => {
  const dir = tempDir(t, Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, ''])));
  const empty = tempDir(t, {});
  const { lines } = await setup(t, dir, empty);
  const screen = await lines();
  const names = screen.map((line) => /│(f\d+)/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(names.slice(0, 3), ['f0', 'f1', 'f2']);
  assert.ok(names.length < 50, `${names.length} rows rendered`);
  assert.match(screen[1], /│Empty +│$/);
});

test('the cursor line is inverse in the active pane, dimmed in the other, in the entry\'s colors', async (t) => {
  const level = chalk.level;
  chalk.level = 2;
  t.after(() => {
    chalk.level = level;
  });
  const dir = tempDir(t, { src: null, 'a.txt': '' });
  const { lines } = await setup(t, dir);
  const row = (await lines())[1];
  // Active: the directory's color (74) as the background, the window's (234) as the text.
  assert.ok(row.includes('\x1b[48;5;74m'), JSON.stringify(row));
  assert.ok(row.includes('\x1b[38;5;234m'));
  // The other pane: OtherLine's background (235), the directory's color as the text.
  assert.ok(row.includes('\x1b[48;5;235m'));
  assert.ok(row.includes('\x1b[38;5;74m'));
});

test('hidden entries are faded; the bottom border says the order, when it is not by name, and how many are hidden', async (t) => {
  const level = chalk.level;
  chalk.level = 2;
  t.after(() => {
    chalk.level = level;
  });
  const dir = tempDir(t, { '.env': '', a: '' });
  const { main, lines } = await setup(t, dir);
  const screen = await lines();
  const row = (/** @type {string} */ name) => screen.find((line) => line.includes(name)) ?? '';
  // SGR 2: faint.
  assert.ok(row('.env').includes('[2m.env'), JSON.stringify(row('.env')));
  assert.ok(!row('a  ').includes('[2m'), JSON.stringify(row('a  ')));
  main.left.sort('size', true);
  main.left.hideHiddenEntries();
  const bottom = (await lines()).find((line) => line.startsWith('') && line.includes('╰')) ?? '';
  assert.match(bottom.replace(/\[[\d;]*m/g, ''), /^╰─ size, largest first · 1 hidden ─+╯╭?/);
});

test('selected rows get a check in a gutter shown while anything is selected; the border counts them', async (t) => {
  const dir = tempDir(t, { a: '', b: '', c: '', d: '' });
  const { main, lines } = await setup(t, dir);
  /** @returns {Promise<string[]>} The left pane's rows, as far as the names go. */
  const rows = async () => (await lines()).slice(1, 5).map((line) => line.slice(1, 5));
  assert.deepEqual(await rows(), ['a   ', 'b   ', 'c   ', 'd   '], 'no gutter');
  main.left.toggleSelection();
  assert.deepEqual(await rows(), ['✓ a ', '  b ', '  c ', '  d ']);
  main.left.last();
  main.left.groupSelection();
  main.left.up();
  const screen = await lines();
  assert.deepEqual(screen.slice(1, 5).map((line) => line.slice(1, 5)), ['✓ a ', '  b ', '✓ c ', '✓ d ']);
  assert.match(screen.find((line) => line.startsWith('╰')) ?? '', /─ GROUP: 3 selected ─╯/);
  main.left.groupSelection();
  main.left.unselect();
  assert.deepEqual(await rows(), ['a   ', 'b   ', 'c   ', 'd   ']);
});

test('selectionCount counts the group being selected, and each entry once', () => {
  const entries = ['a', 'b', 'c', 'd'].map((name) => ({ name, type: /** @type {const} */ ('file'), symlink: false, executable: false, size: null, mtime: null, hidden: false }));
  assert.equal(selectionCount(entries, ['a', 'c'], null, 0), 2);
  assert.equal(selectionCount(entries, ['a', 'c'], 3, 1), 4);
  assert.equal(selectionCount(entries, [], 2, 2), 1);
});

test('a page down takes the cursor to the bottom row shown, then pages so that row becomes the top one', async (t) => {
  const dir = tempDir(t, Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, ''])));
  const { main, lines } = await setup(t, dir);
  /** @returns {Promise<string[]>} The left pane's names, top to bottom. */
  const names = async () => (await lines()).map((line) => /^│(f\d+)/.exec(line)?.[1]).filter((name) => name !== undefined);
  const shown = await names();
  const rows = shown.length;
  main.left.pageDown();
  assert.deepEqual(await names(), shown, 'no scrolling yet');
  assert.equal(main.left.state.cursor, rows - 1);
  main.left.pageDown();
  const next = await names();
  assert.equal(next[0], `f${rows - 1}`);
  assert.equal(next.at(-1), `f${2 * rows - 2}`);
  assert.equal(main.left.state.cursor, 2 * rows - 2);
});
