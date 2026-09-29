import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProbe, backgroundFromEnv } from '../src/tui/probe.ts';

const ATTRS = '\x1b[?62;4c';

test('a color reply is read at whatever width the terminal sends', () => {
  assert.deepEqual(readProbe(`\x1b]11;rgb:1e1e/1e1e/2e2e\x07${ATTRS}`).rgb, [30, 30, 46]);
  assert.deepEqual(readProbe(`\x1b]11;rgb:ff/ff/ff\x1b\\${ATTRS}`).rgb, [255, 255, 255]);
  assert.deepEqual(readProbe(`\x1b]11;rgb:f/0/8\x07${ATTRS}`).rgb, [255, 0, 136]);
  assert.deepEqual(readProbe(`\x1b]11;rgba:0000/0000/0000/ffff\x07${ATTRS}`).rgb, [0, 0, 0]);
});

test('attributes without a color means the terminal cannot say, and the wait is over', () => {
  assert.deepEqual(readProbe(ATTRS), { rgb: null, done: true, rest: '' });
});

test('a color with no attributes yet is still waiting', () => {
  const probe = readProbe('\x1b]11;rgb:0000/0000/0000\x07');
  assert.deepEqual(probe.rgb, [0, 0, 0]);
  assert.equal(probe.done, false);
});

test('half a reply is not a reply', () => {
  assert.deepEqual(readProbe('\x1b]11;rgb:1e1e/1e'), { rgb: null, done: false, rest: '\x1b]11;rgb:1e1e/1e' });
});

test('keys typed while waiting are kept, in order', () => {
  const probe = readProbe(`j\x1b]11;rgb:0000/0000/0000\x07j${ATTRS}\r`);
  assert.equal(probe.rest, 'jj\r');
  assert.equal(probe.done, true);
});

test('the environment answers for terminals that cannot', () => {
  assert.deepEqual(backgroundFromEnv({ QUICKREADS_THEME: 'light' }), [255, 255, 255]);
  assert.deepEqual(backgroundFromEnv({ QUICKREADS_THEME: ' Dark ' }), [24, 24, 27]);
  assert.deepEqual(backgroundFromEnv({ COLORFGBG: '15;0' }), [24, 24, 27]);
  assert.deepEqual(backgroundFromEnv({ COLORFGBG: '0;default;15' }), [255, 255, 255]);
  assert.equal(backgroundFromEnv({ COLORFGBG: '15;default' }), null);
  assert.equal(backgroundFromEnv({}), null);
  // The explicit setting wins over the inherited one.
  assert.deepEqual(backgroundFromEnv({ QUICKREADS_THEME: 'light', COLORFGBG: '15;0' }), [255, 255, 255]);
});
