const test = require('node:test');
const assert = require('node:assert/strict');
const { parseKeys, isChord, chordText } = require('./keys');

test('parses VS Code-style sequences into canonical chords', () => {
  /** @type {[string, string[]][]} */
  const cases = [
    ['j', ['j']],
    ['g g', ['g', 'g']],
    ['  d   d ', ['d', 'd']],
    ['G', ['shift+g']],
    ['shift+g', ['shift+g']],
    ['Shift+G', ['shift+g']],
    ['ctrl+w h', ['ctrl+w', 'h']],
    ['shift+ctrl+alt+x', ['ctrl+alt+shift+x']],
    ['Ctrl+Shift+Tab', ['ctrl+shift+tab']],
    ['space', ['space']],
    ['Enter', ['enter']],
    ['escape', ['escape']],
    ['pageup', ['pageup']],
    [':', [':']],
    ['?', ['?']],
    ['+', ['+']],
    ['ctrl++', ['ctrl++']],
    ['alt+ж', ['alt+ж']],
    ['Ж', ['shift+ж']],
  ];
  for (const [text, chords] of cases) {
    assert.deepEqual(parseKeys(text), chords, text);
  }
});

test('explains malformed keys', () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ['', /Empty key sequence/],
    ['ctrl', /"ctrl" needs a key after it, e\.g\. "ctrl\+x"/],
    ['ctrl+', /"ctrl\+" isn't a key/],
    ['esc', /"esc" isn't a key; use one character or one of: space, tab, enter, escape/],
    ['ctrl+ctrl+x', /repeats ctrl/],
    ['shift+;', /shift combines only with letters and named keys; write the character it types/],
    ['meta+x', /"meta\+x" isn't a key/],
    ['F2', /function keys are left to the OS/],
    ['ctrl+f12', /function keys are left to the OS/],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => parseKeys(text), message, text);
  }
});

test('isChord accepts exactly one canonical chord', () => {
  assert.ok(isChord('j'));
  assert.ok(isChord('ctrl+alt+shift+x'));
  assert.ok(!isChord('G'), 'canonical is shift+g');
  assert.ok(!isChord('shift+ctrl+x'), 'canonical order is ctrl+alt+shift');
  assert.ok(!isChord('g g'));
  assert.ok(!isChord('Enter'));
  assert.ok(!isChord(42));
});

test('chordText gives the character a chord types, or null', () => {
  /** @type {[string, string | null][]} */
  const cases = [
    ['j', 'j'],
    ['shift+g', 'G'],
    ['shift+ж', 'Ж'],
    [':', ':'],
    ['+', '+'],
    ['space', ' '],
    ['enter', null],
    ['shift+tab', null],
    ['ctrl+w', null],
    ['alt+x', null],
    ['ctrl+shift+a', null],
  ];
  for (const [chord, text] of cases) {
    assert.equal(chordText(chord), text, chord);
  }
});
