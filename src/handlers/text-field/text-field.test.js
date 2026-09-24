const test = require('node:test');
const assert = require('node:assert/strict');
const Handler = require('../../handler');
const TextField = require('./text-field');
const { openOverMain } = require('../../../test/dialogs');

/** A window holding one text field, focused. */
class Form extends Handler {
  /** @param {ConstructorParameters<typeof TextField>[1]} [options] */
  constructor(options) {
    super('form');
    this.field = new TextField('field', options);
    this.add(this.field);
  }

  onInit() {
    this.field.focus();
  }
}

/**
 * The field's text with `|` at the cursor.
 * @param {InstanceType<typeof TextField>} field
 */
const shown = (field) => {
  const chars = [...field.state.value];
  chars.splice(field.state.cursor, 0, '|');
  return chars.join('');
};

test('typed characters go into the focused field before any keybinding, editing keys edit', async () => {
  /** @type {string[]} */
  const changes = [];
  const { vin, window, press, focus } = await openOverMain(new Form({ value: 'ab', onChange: (value) => changes.push(value) }));
  const { field } = window;
  assert.equal(focus(), 'main.form.field', 'a window can focus a sub-handler as it opens');
  assert.equal(vin.windows.windows[0].focus, 'main', "the opener's window keeps its own focus");
  assert.equal(shown(field), 'ab|');

  // `j` and `g g` would be bound elsewhere; `space` and `shift+x` type too.
  await press('j g g space shift+x');
  assert.equal(shown(field), 'abjgg X|');
  await press('home right ctrl+f');
  assert.equal(shown(field), 'ab|jgg X');
  await press('delete backspace');
  assert.equal(shown(field), 'a|gg X');
  await press('ctrl+e left ctrl+b ctrl+a end');
  assert.equal(shown(field), 'agg X|');
  await press('ctrl+left');
  assert.equal(shown(field), 'agg |X');
  await press('alt+b alt+f');
  assert.equal(shown(field), 'agg| X');
  await press('ctrl+u');
  assert.equal(shown(field), '| X');
  await press('ctrl+k');
  assert.equal(shown(field), '|');
  assert.deepEqual(changes.at(-1), '');
  assert.equal(new Set(changes).size, changes.length, 'onChange only for real changes');
});

test('words are letters and digits: ctrl+w and alt+d stop at dots and slashes', async () => {
  const { window, press } = await openOverMain(new Form({ value: '~/docs/notes.txt', cursor: 11 }));
  const { field } = window;
  assert.equal(shown(field), '~/docs/note|s.txt');
  await press('ctrl+w');
  assert.equal(shown(field), '~/docs/|s.txt');
  await press('alt+d');
  assert.equal(shown(field), '~/docs/|.txt');
  await press('alt+backspace');
  assert.equal(shown(field), '~/|.txt');
  await press('ctrl+right');
  assert.equal(shown(field), '~/.txt|');
});

test('pastes and setText insert one clean line; nothing moves past the ends', async () => {
  const { window, press, paste } = await openOverMain(new Form({ value: 'x\ty\n', cursor: 0 }));
  const { field } = window;
  assert.equal(shown(field), '|x y', 'the initial value is cleaned too');
  assert.equal(await paste('a\r\nb\u0007c\n'), true);
  assert.equal(shown(field), 'a bc|x y');
  field.setText('plain', 2);
  assert.equal(shown(field), 'pl|ain');
  field.setText('reset');
  assert.equal(shown(field), 'reset|');
  await press('right delete ctrl+d');
  assert.equal(shown(field), 'reset|');
  await press('home left backspace ctrl+w');
  assert.equal(shown(field), '|reset');
  assert.throws(() => field.setText(/** @type {any} */ (5)), TypeError);
  assert.throws(() => new TextField('bad', { value: /** @type {any} */ (null) }), /needs a string value/);
  assert.equal(new TextField('secret', { secret: true }).name, 'secret');
});

test('a paste goes nowhere when the focus takes no text', async () => {
  const { paste } = await openOverMain(new Handler('plain'));
  assert.equal(await paste('text'), false);
});
