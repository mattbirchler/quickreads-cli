import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accent, canTint, hyperlink, isDark, selected, setBackground, stripAnsi, surface, tagInk } from '../src/ansi.ts';

// Color only happens at a terminal, so these tests stand one up: a TTY
// stdout that speaks truecolor, put back the way it was afterward.
function atTerminal<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const saved: Record<string, string | undefined> = {};
  const all = { NO_COLOR: undefined, COLORTERM: 'truecolor', TERM: 'xterm-256color', ...env };
  for (const [key, value] of Object.entries(all)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    return fn();
  } finally {
    setBackground(null);
    if (tty === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdout, 'isTTY', tty);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the selection is a wash of the terminal\'s own background when that is known', () => {
  atTerminal({}, () => {
    setBackground([30, 30, 46]);
    assert.equal(canTint(), true);
    const row = selected('  A title  ');
    assert.match(row, /^\x1b\[48;2;\d+;\d+;\d+m {2}A title {2}\x1b\[49m$/);
    // Mostly the background, leaning purple: not a slab of accent.
    const [r, g, b] = /48;2;(\d+);(\d+);(\d+)/.exec(row)!.slice(1).map(Number) as [number, number, number];
    assert.ok(r < 90 && g < 90 && b < 120 && b > g, `${r},${g},${b}`);
  });
});

test('the wash stays light on a light background', () => {
  atTerminal({}, () => {
    setBackground([255, 255, 255]);
    assert.equal(isDark(), false);
    const [r, g, b] = /48;2;(\d+);(\d+);(\d+)/.exec(selected('x'))!.slice(1).map(Number) as [number, number, number];
    assert.ok(r > 200 && g > 200 && b > 230, `${r},${g},${b}`);
  });
});

test('inks on the selected row do not end the wash', () => {
  atTerminal({}, () => {
    setBackground([30, 30, 46]);
    const row = selected(`${accent('▍')} Title`);
    // The only background reset is the one at the very end.
    assert.equal(row.indexOf('\x1b[49m'), row.length - '\x1b[49m'.length);
    assert.equal(stripAnsi(row), '▍ Title');
  });
});

test('without a known background the selection is reverse video', () => {
  atTerminal({}, () => {
    assert.equal(canTint(), false);
    assert.equal(selected('row'), '\x1b[7mrow\x1b[27m');
    // And a surface is nothing at all, rather than a guess.
    assert.equal(surface('code'), 'code');
  });
});

test('without truecolor the selection is reverse video, whatever is known', () => {
  atTerminal({ COLORTERM: undefined }, () => {
    setBackground([30, 30, 46]);
    assert.equal(selected('row'), '\x1b[7mrow\x1b[27m');
  });
});

test('the accent is heavier on a light background', () => {
  atTerminal({}, () => {
    setBackground([20, 20, 20]);
    assert.ok(accent('x').includes('38;2;167;139;250'));
    setBackground([250, 250, 250]);
    assert.ok(accent('x').includes('38;2;124;58;237'));
  });
});

test('tags wear their own color, and an unknown one goes quiet', () => {
  atTerminal({}, () => {
    assert.ok(tagInk('blue', '#Tech').includes('38;2;96;165;250'));
    assert.ok(tagInk('chartreuse', '#Odd').includes('38;2;159;162;171'));
    assert.equal(stripAnsi(tagInk('red', '#Urgent')), '#Urgent');
  });
});

test('a hyperlink wraps its text and cannot be broken out of', () => {
  atTerminal({}, () => {
    assert.equal(hyperlink('https://example.com/a', 'here'), '\x1b]8;;https://example.com/a\x07here\x1b]8;;\x07');
    assert.equal(stripAnsi(hyperlink('https://example.com/a', 'here')), 'here');
    assert.ok(!hyperlink('https://example.com/\x07\x1b]0;pwned', 'x').slice(5, -8).includes('\x07\x1b'));
  });
});

test('NO_COLOR and pipes get plain text from every helper', () => {
  atTerminal({ NO_COLOR: '1' }, () => {
    setBackground([30, 30, 46]);
    assert.equal(selected('row'), 'row');
    assert.equal(hyperlink('https://example.com', 'text'), 'text');
    assert.equal(tagInk('blue', '#Tech'), '#Tech');
  });
  setBackground([30, 30, 46]);
  assert.equal(selected('row'), 'row');
  setBackground(null);
});
