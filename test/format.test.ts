import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactTime, readingTime, hostOf, titleOf, siteOf, rowMeta, count } from '../src/format.ts';
import { stringWidth, truncate, padEnd, padStart, stripAnsi } from '../src/ansi.ts';
import type { Article } from '../src/types.ts';

const NOW = new Date('2026-09-29T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function article(over: Partial<Article> = {}): Article {
  return {
    id: 'abc', url: 'https://www.example.com/post', title: 'A Headline', author: null, siteName: 'Example',
    excerpt: null, wordCount: 1190, type: 'article', publishedAt: null,
    savedAt: ago(2 * HOUR).toISOString(), archivedAt: null, ...over,
  };
}

test('compactTime climbs from now to a date', () => {
  assert.equal(compactTime(ago(20_000), NOW), 'now');
  assert.equal(compactTime(ago(5 * MIN), NOW), '5m');
  assert.equal(compactTime(ago(3 * HOUR), NOW), '3h');
  assert.equal(compactTime(ago(6 * DAY), NOW), '6d');
  assert.equal(compactTime(ago(20 * DAY), NOW), 'Sep 9');
  assert.equal(compactTime(new Date('2025-03-02T12:00:00Z'), NOW), 'Mar 2, 2025');
  assert.equal(compactTime(null, NOW), '');
  assert.equal(compactTime(new Date('nonsense'), NOW), '');
});

test('readingTime rounds to minutes and never says zero', () => {
  assert.equal(readingTime(1190), '5 min');
  assert.equal(readingTime(40), '1 min');
  assert.equal(readingTime(0), '');
});

test('titles and sites fall back to the hostname', () => {
  assert.equal(hostOf('https://www.example.com/a'), 'example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(titleOf({ title: '  ', url: 'https://www.example.com/a' }), 'example.com');
  assert.equal(siteOf({ siteName: null, url: 'https://www.example.com/a' }), 'example.com');
  // A placeholder address is not a site.
  assert.equal(siteOf({ siteName: null, url: 'https://quickreads.app/t/1', hasOriginalUrl: false }), '');
});

test('rowMeta says where, how long, how far, how old', () => {
  assert.equal(rowMeta(article(), NOW), 'Example · 5 min · 2h');
  assert.equal(rowMeta(article({ readProgress: 0.42 }), NOW), 'Example · 5 min · 42% · 2h');
  assert.equal(rowMeta(article({ type: 'link', wordCount: 0 }), NOW), 'Example · link · 2h');
  // In the archive the age is how long ago it was archived.
  assert.equal(rowMeta(article({ archivedAt: ago(10 * MIN).toISOString() }), NOW), 'Example · 5 min · 10m');
});

test('counts agree with their nouns', () => {
  assert.equal(count(1, 'article'), '1 article');
  assert.equal(count(0, 'article'), '0 articles');
  assert.equal(count(2, 'match', 'matches'), '2 matches');
});

test('widths are measured in columns', () => {
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('日本'), 4);
  assert.equal(stringWidth('é'), 1);
  assert.equal(stringWidth('a\x07b'), 2);
});

test('truncate and pad respect those widths', () => {
  assert.equal(truncate('hello world', 8), 'hello w…');
  assert.equal(truncate('hello', 8), 'hello');
  assert.equal(truncate('日本語テキスト', 5), '日本…');
  assert.equal(truncate('hello', 0), '');
  assert.equal(padEnd('ab', 4), 'ab  ');
  assert.equal(padEnd('abcdef', 4), 'abc…');
  assert.equal(padStart('7', 3), '  7');
});

test('stripAnsi removes styling and terminal titles', () => {
  assert.equal(stripAnsi('\x1b[1mbold\x1b[22m \x1b[38;2;1;2;3mink\x1b[39m\x1b]0;title\x07'), 'bold ink');
});
