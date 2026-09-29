import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml, markHighlights, blockText, decodeEntities, htmlToText } from '../src/html.ts';

test('paragraphs become blocks with their whitespace collapsed', () => {
  const doc = parseHtml('<p>First\n   paragraph.</p>\n<p> Second&nbsp;one. </p>');
  assert.deepEqual(doc.blocks.map(blockText), ['First paragraph.', 'Second one.']);
});

test('text outside any paragraph is still a block', () => {
  const doc = parseHtml('Loose text<div>and a div</div>trailing');
  assert.deepEqual(doc.blocks.map(blockText), ['Loose text', 'and a div', 'trailing']);
});

test('headings keep their level', () => {
  const doc = parseHtml('<h2>Section</h2><p>Body</p><h4>Minor</h4>');
  assert.deepEqual(doc.blocks.map((b) => [b.kind, b.level]), [['heading', 2], ['text', 0], ['heading', 4]]);
});

test('inline styles ride on spans and neighbours merge', () => {
  const [block] = parseHtml('<p>Plain <strong>bold <em>both</em></strong> <code>x = 1</code></p>').blocks;
  assert.deepEqual(block!.spans, [
    { text: 'Plain ' },
    { text: 'bold ', bold: true },
    { text: 'both', bold: true, italic: true },
    { text: ' ' },
    { text: 'x = 1', code: true },
  ]);
});

test('entities decode, including numeric ones', () => {
  assert.equal(decodeEntities('Tom &amp; Jerry &#8212; &#x2019;s &mdash; &unknown;'), 'Tom & Jerry — ’s — &unknown;');
  // An out-of-range code point is left alone rather than thrown on.
  assert.equal(decodeEntities('&#99999999;'), '&#99999999;');
});

test('list items get bullets, numbers, and nesting', () => {
  const doc = parseHtml('<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul><ol start="9"><li>Nine</li><li>Ten</li></ol>');
  assert.deepEqual(doc.blocks.map((b) => [blockText(b), b.bullet, b.indent, b.hang]), [
    ['One', '•', 0, 2],
    ['Nested', '•', 2, 2],
    ['Two', '•', 0, 2],
    ['Nine', ' 9.', 0, 4],
    ['Ten', '10.', 0, 4],
  ]);
});

test('a second paragraph in a list item hangs without a second bullet', () => {
  const doc = parseHtml('<ul><li><p>First</p><p>Second</p></li></ul>');
  assert.deepEqual(doc.blocks.map((b) => [blockText(b), b.bullet, b.hang]), [['First', '•', 2], ['Second', '', 2]]);
});

test('blockquotes nest', () => {
  const doc = parseHtml('<blockquote><p>Quoted</p><blockquote><p>Deeper</p></blockquote></blockquote><p>Out</p>');
  assert.deepEqual(doc.blocks.map((b) => [blockText(b), b.quote]), [['Quoted', 1], ['Deeper', 2], ['Out', 0]]);
});

test('code blocks keep their whitespace and ignore markup inside', () => {
  const doc = parseHtml('<pre><code>\nfunction <span class="k">f</span>() {\n\treturn a &lt; b;\n}\n</code></pre>');
  assert.equal(doc.blocks.length, 1);
  assert.equal(doc.blocks[0]!.kind, 'pre');
  assert.deepEqual(doc.blocks[0]!.lines, ['function f() {', '  return a < b;', '}']);
});

test('links are numbered in order and repeated targets share a number', () => {
  const doc = parseHtml('<p><a href="https://a.example/">one</a>, <a href="https://b.example/">two</a>, <a href="https://a.example/">again</a></p>');
  assert.deepEqual(doc.links, ['https://a.example/', 'https://b.example/']);
  const notes = doc.blocks[0]!.spans.filter((s) => s.note).map((s) => s.text);
  assert.deepEqual(notes, ['[1]', '[2]', '[1]']);
  // Markers are apparatus: they are not part of the prose.
  assert.equal(blockText(doc.blocks[0]!), 'one, two, again');
});

test('relative links resolve against the article, and dead ends get no marker', () => {
  const doc = parseHtml(
    '<p><a href="/about">About</a> <a href="#top">Top</a> <a href="javascript:alert(1)">Bad</a> <a href="https://example.com/x">https://example.com/x</a></p>',
    'https://example.com/posts/1',
  );
  assert.deepEqual(doc.links, ['https://example.com/about']);
});

test('scripts, styles and comments never reach the page', () => {
  const doc = parseHtml('<p>Seen</p><script>alert("<p>no</p>")</script><style>p { color: red }</style><!-- <p>hidden</p> --><p>Also seen</p>');
  assert.deepEqual(doc.blocks.map(blockText), ['Seen', 'Also seen']);
});

test('an attribute value containing > does not end the tag early', () => {
  const doc = parseHtml('<p><a href="https://example.com/?a=1&amp;b=2" title="a > b">link</a> after</p>');
  assert.equal(blockText(doc.blocks[0]!), 'link after');
  assert.deepEqual(doc.links, ['https://example.com/?a=1&b=2']);
});

test('a stray < is just a character', () => {
  assert.deepEqual(parseHtml('<p>1 < 2 and 3 > 2</p>').blocks.map(blockText), ['1 < 2 and 3 > 2']);
});

test('images say what they show, when they say anything', () => {
  const doc = parseHtml('<figure><img src="a.png" alt="A chart of sales"><figcaption>Sales, 2026</figcaption></figure><p><img src="b.png"></p>');
  assert.deepEqual(doc.blocks.map((b) => b.spans.map((s) => s.text).join('')), ['[Image: A chart of sales]', 'Sales, 2026']);
  assert.equal(doc.blocks[1]!.caption, true);
});

test('hard breaks and rules survive', () => {
  const doc = parseHtml('<p>Line one<br>Line two<br></p><hr><p>After</p>');
  assert.deepEqual(doc.blocks[0]!.spans, [{ text: 'Line one' }, { text: '', br: true }, { text: 'Line two' }]);
  assert.equal(doc.blocks[1]!.kind, 'rule');
});

test('table rows read as separated cells', () => {
  const doc = parseHtml('<table><tr><th>Name</th><th>Score</th></tr><tr><td>Ada</td><td>10</td></tr></table>');
  assert.deepEqual(doc.blocks.map((b) => b.spans.map((s) => s.text).join('')), ['Name · Score', 'Ada · 10']);
});

test('empty and malformed input is an empty document', () => {
  assert.deepEqual(parseHtml('').blocks, []);
  assert.deepEqual(parseHtml('<p></p><div>  </div>').blocks, []);
  assert.deepEqual(parseHtml('</p></ul></blockquote><p>Fine</p>').blocks.map(blockText), ['Fine']);
});

test('a highlight inside one paragraph is marked across inline markup', () => {
  const doc = parseHtml('<p>The quick <em>brown</em> fox jumps over the lazy dog.</p>');
  assert.equal(markHighlights(doc, ['quick brown fox']), 1);
  assert.deepEqual(doc.blocks[0]!.spans, [
    { text: 'The ' },
    { text: 'quick ', mark: true },
    { text: 'brown', italic: true, mark: true },
    { text: ' fox', mark: true },
    { text: ' jumps over the lazy dog.' },
  ]);
});

test('a highlight is matched whatever its whitespace', () => {
  const doc = parseHtml('<p>Some words in a row.</p>');
  assert.equal(markHighlights(doc, ['  words\n in   a ']), 1);
  assert.deepEqual(doc.blocks[0]!.spans.filter((s) => s.mark).map((s) => s.text), ['words in a']);
});

test('a link marker inside a highlight joins it; one outside does not', () => {
  const doc = parseHtml('<p>See <a href="https://a.example/">the docs</a> for more, or <a href="https://b.example/">ask</a>.</p>');
  markHighlights(doc, ['the docs for more']);
  const spans = doc.blocks[0]!.spans;
  assert.equal(spans.find((s) => s.text === '[1]')!.mark, true);
  assert.equal(spans.find((s) => s.text === '[2]')!.mark, undefined);
});

test('a highlight running across paragraphs marks each part', () => {
  const doc = parseHtml('<p>Opening paragraph that ends here.</p><p>Middle paragraph.</p><p>Closing paragraph continues on.</p>');
  assert.equal(markHighlights(doc, ['that ends here. Middle paragraph. Closing paragraph']), 1);
  const marked = doc.blocks.map((b) => b.spans.filter((s) => s.mark).map((s) => s.text).join(''));
  assert.deepEqual(marked, ['that ends here.', 'Middle paragraph.', 'Closing paragraph']);
});

test('a highlight that is not in the text marks nothing', () => {
  const doc = parseHtml('<p>Nothing to see here.</p><p>Here either.</p>');
  assert.equal(markHighlights(doc, ['entirely different words', '', 'here. Something else']), 0);
  assert.ok(doc.blocks.every((b) => b.spans.every((s) => !s.mark)));
});

test('htmlToText flattens to paragraphs', () => {
  assert.equal(htmlToText('<h1>Title</h1><p>Body <b>text</b>.</p>'), 'Title\n\nBody text.');
});
