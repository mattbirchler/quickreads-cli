import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys, isPrintable } from '../src/tui/keys.ts';

test('arrows and paging keys have names', () => {
  assert.deepEqual(parseKeys('\x1b[A'), ['up']);
  assert.deepEqual(parseKeys('\x1b[B\x1b[B'), ['down', 'down']);
  assert.deepEqual(parseKeys('\x1bOA'), ['up']);
  assert.deepEqual(parseKeys('\x1b[5~\x1b[6~'), ['pageup', 'pagedown']);
  assert.deepEqual(parseKeys('\x1b[Z'), ['shift-tab']);
});

test('a bare escape byte is Esc', () => {
  assert.deepEqual(parseKeys('\x1b'), ['esc']);
});

test('control bytes have names and the rest are themselves', () => {
  assert.deepEqual(parseKeys('\r'), ['enter']);
  assert.deepEqual(parseKeys('\t'), ['tab']);
  assert.deepEqual(parseKeys('\x7f'), ['backspace']);
  assert.deepEqual(parseKeys('\x03'), ['ctrl-c']);
  assert.deepEqual(parseKeys('a/?G'), ['a', '/', '?', 'G']);
});

test('a paste arrives as its characters, in order', () => {
  assert.deepEqual(parseKeys('https://a.co\r'), [...'https://a.co', 'enter']);
  assert.deepEqual(parseKeys('日本'), ['日', '本']);
  assert.deepEqual(parseKeys('👍'), ['👍']);
});

test('sequences nobody asked about vanish whole', () => {
  // F5, and a mouse report: neither should type "[15~" into a prompt.
  assert.deepEqual(parseKeys('\x1b[15~'), []);
  assert.deepEqual(parseKeys('a\x1b[<0;10;5Mb'), ['a', 'b']);
  assert.deepEqual(parseKeys('\x00\x1a'), []);
});

test('isPrintable tells typing from doing', () => {
  assert.equal(isPrintable('a'), true);
  assert.equal(isPrintable(' '), true);
  assert.equal(isPrintable('👍'), true);
  assert.equal(isPrintable('enter'), false);
  assert.equal(isPrintable('up'), false);
});
