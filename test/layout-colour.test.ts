import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setBackground, stripAnsi, stringWidth } from '../src/ansi.ts';
import { parseHtml } from '../src/html.ts';
import { layoutDocument, renderArticle } from '../src/layout.ts';
import type { Article } from '../src/types.ts';

// The layout tests elsewhere run without colour. These stand up a truecolor
// terminal to check what colour adds, and that it adds no width.
function atTerminal<T>(background: [number, number, number] | null, fn: () => T): T {
  const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const saved = { NO_COLOR: process.env['NO_COLOR'], COLORTERM: process.env['COLORTERM'] };
  delete process.env['NO_COLOR'];
  process.env['COLORTERM'] = 'truecolor';
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  setBackground(background);
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

const HTML = '<h2>Title</h2><p>Read <a href="https://a.example/x">the <b>docs</b></a> and <a href="https://b.example/">more</a>.</p>'
  + '<pre>short()\nquite_a_bit_longer(line)</pre><blockquote><p>Quoted.</p></blockquote>';

test('links open on a click when asked, and only the link text does', () => {
  atTerminal([30, 30, 46], () => {
    const lines = layoutDocument(parseHtml(HTML), 60, [], { hyperlinks: true });
    const line = lines.find((l) => l.includes('Read'))!;
    // Both parts of a link with markup inside it go to the same place.
    assert.equal(line.split('\x1b]8;;https://a.example/x\x07').length - 1, 2);
    assert.equal(line.split('\x1b]8;;https://b.example/\x07').length - 1, 1);
    // Every link that opens is closed again.
    assert.equal(line.split('\x1b]8;;\x07').length - 1, 3);
    assert.equal(stripAnsi(line), 'Read the docs[1] and more[2].');
    // The list at the end is clickable too.
    assert.ok(lines.at(-1)!.includes('\x1b]8;;https://b.example/\x07'));
  });
});

test('links are plain underlines when not asked', () => {
  atTerminal([30, 30, 46], () => {
    const lines = layoutDocument(parseHtml(HTML), 60);
    assert.ok(lines.every((l) => !l.includes('\x1b]8;')));
    assert.ok(lines.some((l) => l.includes('\x1b[4m')));
  });
});

test('code sits on a panel as wide as its longest line, padded above and below', () => {
  atTerminal([30, 30, 46], () => {
    const lines = layoutDocument(parseHtml(HTML), 60);
    const panel = lines.filter((l) => l.includes('\x1b[48;2;'));
    assert.equal(panel.length, 4);
    assert.deepEqual(panel.map((l) => stripAnsi(l).trimEnd()), ['', '  short()', '  quite_a_bit_longer(line)', '']);
    const widths = panel.map((l) => stringWidth(stripAnsi(l)));
    assert.deepEqual(widths, [28, 28, 28, 28]);
  });
});

test('without a known background code is indented and quiet, with no panel', () => {
  atTerminal(null, () => {
    const lines = layoutDocument(parseHtml(HTML), 60);
    assert.ok(lines.every((l) => !l.includes('\x1b[48;')));
    assert.ok(lines.some((l) => stripAnsi(l) === '  short()'));
  });
});

test('colour never changes where the lines break', () => {
  const article: Article = {
    id: 'a', url: 'https://example.com/post', title: 'A Headline', author: null, siteName: 'Example',
    content: `${HTML}<p>${'word '.repeat(80)}</p><ul><li>One <code>item</code></li></ul>`, excerpt: null,
    wordCount: 500, type: 'article', publishedAt: null, savedAt: '2026-09-16T12:00:00.000Z', archivedAt: null,
    tags: [{ id: 't', name: 'Tech', color: 'blue' }],
  };
  const plain = renderArticle(article, { width: 50 }).lines;
  const coloured = atTerminal(null, () => renderArticle(article, { width: 50, hyperlinks: true }).lines);
  assert.deepEqual(coloured.map((l) => stripAnsi(l)), plain);
  assert.ok(coloured.some((l) => l.includes('\x1b[')), 'and it was in colour');
  assert.ok(coloured.every((l) => stringWidth(stripAnsi(l)) <= 50));
});
