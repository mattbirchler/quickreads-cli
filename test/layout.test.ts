import { test } from 'node:test';
import assert from 'node:assert/strict';

// NO_COLOR strips the escape codes so assertions read as text.
process.env['NO_COLOR'] = '1';

import { parseHtml } from '../src/html.ts';
import { layoutDocument, wrapText, renderArticle, articleHeader } from '../src/layout.ts';
import { stringWidth } from '../src/ansi.ts';
import type { Article } from '../src/types.ts';

const lay = (html: string, width: number): string[] => layoutDocument(parseHtml(html), width);

function article(over: Partial<Article> = {}): Article {
  return {
    id: 'abc', url: 'https://example.com/post', title: 'A Headline', author: 'Ada Writer', siteName: 'Example',
    content: '<p>Body text.</p>', excerpt: null, wordCount: 1190, type: 'article',
    publishedAt: '2026-09-15T12:00:00.000Z', savedAt: '2026-09-16T12:00:00.000Z', archivedAt: null, ...over,
  };
}

test('prose wraps at the width and never past it', () => {
  const lines = lay(`<p>${'word '.repeat(60)}</p>`, 30);
  assert.ok(lines.length > 5);
  assert.ok(lines.every((l) => stringWidth(l) <= 30));
  assert.ok(lines.every((l) => l === l.trim()));
});

test('blocks are separated by one blank line', () => {
  assert.deepEqual(lay('<h2>Title</h2><p>One.</p><p>Two.</p>', 40), ['Title', '', 'One.', '', 'Two.']);
});

test('a word never breaks across spans', () => {
  const lines = lay('<p>aaaa bbbb <b>cc</b>dd<a href="https://x.example/">ee</a></p>', 12);
  assert.deepEqual(lines.slice(0, 2), ['aaaa bbbb', 'ccddee[1]']);
});

test('a word longer than the line is cut rather than overflowing', () => {
  const lines = lay('<p>see https://example.com/a/very/long/path/that/keeps/going/and/going ok</p>', 20);
  assert.ok(lines.every((l) => stringWidth(l) <= 20));
  assert.equal(lines.join('').replace(/ /g, ''), 'seehttps://example.com/a/very/long/path/that/keeps/going/and/goingok');
});

test('list items sit together and wrap under their own text', () => {
  const lines = lay('<p>Intro.</p><ul><li>First item that is long enough to wrap around</li><li>Second</li></ul><p>Outro.</p>', 24);
  assert.deepEqual(lines, [
    'Intro.',
    '',
    '• First item that is',
    '  long enough to wrap',
    '  around',
    '• Second',
    '',
    'Outro.',
  ]);
});

test('numbered and nested lists line up', () => {
  const lines = lay('<ol><li>One<ul><li>Inner</li></ul></li><li>Two</li></ol>', 30);
  assert.deepEqual(lines, [' 1. One', '    • Inner', ' 2. Two']);
});

test('quotes carry a bar on every line, gaps included', () => {
  const lines = lay('<blockquote><p>First quoted paragraph here.</p><p>Second.</p></blockquote><p>After.</p>', 20);
  assert.deepEqual(lines, ['│ First quoted', '│ paragraph here.', '│', '│ Second.', '', 'After.']);
});

test('code keeps its indentation', () => {
  const lines = lay('<pre>if (x) {\n  y();\n}</pre>', 40);
  assert.deepEqual(lines, ['  if (x) {', '    y();', '  }']);
});

test('hard breaks break', () => {
  assert.deepEqual(lay('<p>Roses are red<br>Violets are blue</p>', 40), ['Roses are red', 'Violets are blue']);
});

test('links are listed at the end under their numbers', () => {
  const lines = lay('<p>Read <a href="https://a.example/one">this</a> and <a href="https://b.example/two">that</a>.</p>', 60);
  assert.deepEqual(lines, [
    'Read this[1] and that[2].',
    '',
    '─'.repeat(24),
    'Links',
    '[1] https://a.example/one',
    '[2] https://b.example/two',
  ]);
});

test('deep nesting in a narrow pane still leaves room to read', () => {
  const html = '<blockquote><ul><li><ul><li><ul><li>Deeply nested words here</li></ul></li></ul></li></ul></blockquote>';
  const lines = lay(html, 22);
  assert.ok(lines.every((l) => stringWidth(l) <= 22));
  assert.ok(lines.length <= 3, 'the text kept most of the line');
});

test('wide characters count as two columns', () => {
  const lines = lay('<p>日本語のテキストは幅が二倍になります</p>', 10);
  assert.ok(lines.every((l) => stringWidth(l) <= 10));
  assert.equal(lines.join(''), '日本語のテキストは幅が二倍になります');
});

test('wrapText wraps plain text and keeps its line breaks', () => {
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('first\nsecond', 20), ['first', 'second']);
  assert.deepEqual(wrapText('', 20), []);
});

test('the header carries title, source line, tags and address', () => {
  const lines = articleHeader(article({ tags: [{ id: '1', name: 'Tech', color: 'blue' }] }), 60);
  assert.deepEqual(lines, [
    'A Headline',
    'Example · Ada Writer · Sep 15, 2026 · 5 min read',
    '#Tech',
    'https://example.com/post',
    '─'.repeat(24),
  ]);
  // The interactive reader leaves the address out: o and c are one key away.
  assert.ok(!articleHeader(article(), 60, false).some((l) => l.includes('https://')));
});

test('a placeholder address is not shown as if it went somewhere', () => {
  const lines = articleHeader(article({ url: 'https://quickreads.app/t/abc', hasOriginalUrl: false, siteName: null }), 60);
  assert.ok(!lines.some((l) => l.includes('quickreads.app/t/')));
});

test('an article renders header, body and links', () => {
  const { lines, links, marked } = renderArticle(
    article({ content: '<p>Hello <a href="/more">there</a>, reader.</p>' }),
    { width: 60, highlights: [{ id: 'h', articleId: 'abc', text: 'there, reader', createdAt: '' }] },
  );
  assert.ok(lines.includes('Hello there[1], reader.'));
  assert.deepEqual(links, ['https://example.com/more']);
  assert.equal(marked, 1);
});

test('a saved link explains why there is nothing to read', () => {
  const blocked = renderArticle(article({ type: 'link', content: null, wordCount: 0, fetchBlocked: true }), { width: 70, emptyHint: 'Press o to open it.' });
  assert.ok(blocked.lines.join(' ').includes('would not serve the page'));
  assert.ok(blocked.lines.join(' ').includes('Press o to open it.'));
  const todo = renderArticle(article({ type: 'link', content: null, wordCount: 0, list: 'todo' }), { width: 70 });
  assert.ok(todo.lines.join(' ').includes('To Do item'));
});

test('output for a pipe carries no escape sequences at all', () => {
  const { lines } = renderArticle(
    article({ content: '<p>See <a href="https://a.example/">this</a>.</p><pre>code()</pre><blockquote><p>Quoted.</p></blockquote>' }),
    { width: 60, hyperlinks: true },
  );
  assert.ok(lines.every((l) => !l.includes('\x1b')));
  assert.ok(lines.includes('See this[1].'));
  assert.ok(lines.includes('  code()'));
  assert.ok(lines.includes('│ Quoted.'));
});
