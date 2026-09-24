import test from 'node:test';
import assert from 'node:assert/strict';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import Handler from '../../../../src/handler.js';
import { createStore, useSelector, shallowEqual } from './index.js';

/** Lets the per-tick state flush and React's re-render run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** @extends {Handler<{ cwd: string, cursor: number, rows: { name: string }[] }>} */
class Pane extends Handler {}

/** A pane handler whose state a fresh store follows — the UI side declares nothing. */
function connect() {
  const pane = new Pane('pane');
  pane.update({ cwd: '/', cursor: 0, rows: [{ name: 'a' }] });
  const store = createStore();
  pane.subscribeState(store.apply);
  return { pane, store };
}

test('components re-render only when the slice they select changes', async () => {
  const { pane, store } = connect();
  const renders = { cwd: 0, cursor: 0, rows: 0 };

  const Cwd = () => {
    renders.cwd++;
    return <Text>cwd={useSelector(store, (s) => s.cwd)}</Text>;
  };
  const Cursor = () => {
    renders.cursor++;
    return <Text>cursor={useSelector(store, (s) => s.cursor)}</Text>;
  };
  const Rows = () => {
    renders.rows++;
    const rows = useSelector(store, (s) => s.rows);
    return <Text>rows={rows.map((/** @type {any} */ r) => r.name).join(',')}</Text>;
  };

  const { lastFrame, unmount } = render(
    <>
      <Cwd />
      <Cursor />
      <Rows />
    </>,
  );
  assert.deepEqual(renders, { cwd: 1, cursor: 1, rows: 1 });

  pane.state.cursor = 1;
  pane.state.cursor = 2;
  await settle();
  assert.match(lastFrame() ?? '', /cursor=2/);
  assert.deepEqual(renders, { cwd: 1, cursor: 2, rows: 1 }, 'two edits in one tick, one render, only Cursor');

  pane.state.rows.push({ name: 'b' });
  await settle();
  assert.match(lastFrame() ?? '', /rows=a,b/);
  assert.deepEqual(renders, { cwd: 1, cursor: 2, rows: 2 });

  pane.update({ cwd: '/tmp', cursor: 2, rows: [{ name: 'a' }, { name: 'b' }] });
  await settle();
  assert.match(lastFrame() ?? '', /cwd=\/tmp/);
  assert.deepEqual(renders, { cwd: 2, cursor: 2, rows: 3 }, 'update() re-renders what changed or was replaced');
  unmount();
});

test('a selector building a new object needs shallowEqual to avoid re-renders', async () => {
  const { pane, store } = connect();
  let renders = 0;
  const Summary = () => {
    renders++;
    const { cwd, cursor } = useSelector(store, (s) => ({ cwd: s.cwd, cursor: s.cursor }), shallowEqual);
    return <Text>{`${cwd}:${cursor}`}</Text>;
  };
  const { lastFrame, unmount } = render(<Summary />);
  assert.equal(renders, 1);

  pane.state.rows.push({ name: 'b' });
  await settle();
  assert.equal(renders, 1, 'an unrelated change does not re-render');

  pane.state.cursor = 5;
  await settle();
  assert.equal(renders, 2);
  assert.match(lastFrame() ?? '', /\/:5/);
  unmount();
});

test('shallowEqual compares one level deep', () => {
  assert.ok(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(shallowEqual([1, 2], [1, 2]));
  assert.ok(!shallowEqual({ a: {} }, { a: {} }));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!shallowEqual([], {}));
  assert.ok(!shallowEqual(null, {}));
});
