import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env['TZ'] = 'UTC';

import {
  compactTime, readingTime, hostOf, titleOf, siteOf, rowMeta, count, dayGroup, timeLeft, progressOf,
} from '../src/format.ts';
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

test('days are calendar days, not 24-hour windows', () => {
  const at = (iso: string): string => dayGroup(new Date(iso), NOW).label;
  assert.equal(at('2026-09-29T00:00:00Z'), 'Today');
  assert.equal(at('2026-09-29T11:59:00Z'), 'Today');
  // An hour and a minute before midnight is 13 hours ago, and yesterday.
  assert.equal(at('2026-09-28T23:59:00Z'), 'Yesterday');
  assert.equal(at('2026-09-28T00:00:00Z'), 'Yesterday');
  assert.equal(at('2026-09-27T23:59:00Z'), 'Past week');
  assert.equal(at('2026-09-23T00:00:00Z'), 'Past week');
  assert.equal(at('2026-09-22T12:00:00Z'), 'Past month');
  assert.equal(at('2026-08-31T12:00:00Z'), 'Past month');
  assert.equal(at('2026-08-30T12:00:00Z'), 'August');
  assert.equal(at('2025-12-25T12:00:00Z'), 'December 2025');
  // A clock set wrong, or a save from a device in tomorrow's timezone.
  assert.equal(at('2026-09-30T03:00:00Z'), 'Today');
  assert.equal(at('nonsense'), 'Undated');
});

test('rows in the same month share a heading, and different years do not', () => {
  const key = (iso: string): string => dayGroup(new Date(iso), NOW).key;
  assert.equal(key('2026-07-01T12:00:00Z'), key('2026-07-31T12:00:00Z'));
  assert.notEqual(key('2026-07-01T12:00:00Z'), key('2025-07-01T12:00:00Z'));
});

test('time left counts down and goes quiet near the end', () => {
  assert.equal(timeLeft(2380, 0), '10 min left');
  assert.equal(timeLeft(2380, 0.5), '5 min left');
  assert.equal(timeLeft(2380, 0.98), '');
  assert.equal(timeLeft(2380, 1), '');
  assert.equal(timeLeft(0, 0.2), '');
});

test('progress only counts when it is under way', () => {
  assert.equal(progressOf({ readProgress: 0.4 }), 0.4);
  assert.equal(progressOf({ readProgress: 0 }), null);
  assert.equal(progressOf({ readProgress: 1 }), null);
  assert.equal(progressOf({}), null);
});
