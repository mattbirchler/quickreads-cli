import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['NO_COLOR'] = '1';

import { createApp, type App, type Terminal } from '../src/tui/app.ts';
import { ApiError } from '../src/api.ts';
import { stringWidth } from '../src/ansi.ts';
import { article, highlight, fakeClient, NOW, type FakeClient } from './helpers/fakes.ts';

const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

interface Rig {
  app: App;
  client: FakeClient;
  frames: string[][];
  opened: string[];
  copied: string[];
  quit: number[];
  size: { cols: number; rows: number };
  /** Send keys, wait for everything they started, return the frame. */
  press(keys: string): Promise<string[]>;
  screen(): string;
}

function library(n = 3): FakeClient {
  return fakeClient({
    articles: [
      ...Array.from({ length: n }, (_, i) => article(`a${i + 1}`, {
        title: `Article ${i + 1}`,
        savedAt: ago((i + 1) * HOUR),
        content: `<p>Body of article ${i + 1}.</p>`,
      })),
      article('old', { title: 'Old news', archivedAt: ago(HOUR), savedAt: ago(90 * HOUR) }),
      article('t1', { title: 'Try this app', list: 'todo', type: 'link', content: null, wordCount: 0 }),
    ],
    highlights: [
      highlight('h1', 'a1', 'Body of article 1.', { articleTitle: 'Article 1', url: 'https://example.com/a1' }),
      highlight('h2', 'a2', 'article 2', { articleTitle: 'Article 2', note: 'Worth remembering.', url: 'https://example.com/a2' }),
    ],
  });
}

async function rig(client: FakeClient = library(), size = { cols: 80, rows: 24 }): Promise<Rig> {
  const frames: string[][] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const quit: number[] = [];
  const term: Terminal = {
    cols: () => size.cols,
    rows: () => size.rows,
    paint: (frame) => { frames.push(frame); },
    open: (url) => { opened.push(url); },
    copy: (text) => { copied.push(text); return true; },
    quit: (code) => { quit.push(code); app.stop(); },
    now: () => NOW,
  };
  const app = createApp(client, term);
  const r: Rig = {
    app, client, frames, opened, copied, quit, size,
    async press(keys) {
      app.input(keys);
      await app.settled();
      return app.frame();
    },
    screen: () => app.frame().join('\n'),
  };
  app.start();
  await app.settled();
  return r;
}

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';
const ENTER = '\r';
const TAB = '\t';

test('it opens on the queue, first article selected', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  const frame = r.app.frame();
  assert.equal(frame.length, 24);
  assert.match(frame[0]!, /^ Quick Reads {2}\[Queue\] {2}To Do {2}Archive +3 articles $/);
  assert.match(frame[2]!, /^ {2}Article 1 +Example · 2 min · 1h {2}$/);
  assert.equal(r.app.state.list.selected, 0);
  assert.match(frame[23]!, /↵ read · a archive/);
});

test('every frame fits the terminal exactly, at any size', async (t) => {
  const client = library(40);
  client.account.articles[0]!.title = 'A very long headline that goes on and on past any reasonable width for a list row';
  for (const size of [{ cols: 80, rows: 24 }, { cols: 40, rows: 10 }, { cols: 140, rows: 50 }, { cols: 20, rows: 5 }]) {
    const r = await rig(client, size);
    t.after(() => r.app.stop());
    for (const keys of ['', DOWN, ENTER, ESC, 'h', ESC, '?', 'x', '/', 'abc', ESC]) {
      const frame = await r.press(keys);
      assert.equal(frame.length, size.rows, `${size.cols}x${size.rows} after ${JSON.stringify(keys)}`);
      for (const line of frame) {
        assert.ok(stringWidth(line) <= size.cols, `${size.cols}x${size.rows} after ${JSON.stringify(keys)}: "${line}"`);
      }
    }
  }
});

test('arrows and j/k move the selection and stop at the ends', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press(DOWN);
  assert.equal(r.app.state.list.selected, 1);
  await r.press('jjjj');
  assert.equal(r.app.state.list.selected, 2);
  await r.press(`k${UP}${UP}${UP}`);
  assert.equal(r.app.state.list.selected, 0);
  await r.press('G');
  assert.equal(r.app.state.list.selected, 2);
  await r.press('g');
  assert.equal(r.app.state.list.selected, 0);
});

test('the list scrolls to keep the selection in view and fetches more near the end', async (t) => {
  const r = await rig(library(120), { cols: 80, rows: 13 });
  t.after(() => r.app.stop());
  assert.match(r.app.frame()[0]!, /50\+ articles/);
  for (let i = 0; i < 45; i++) await r.press(DOWN);
  assert.equal(r.app.state.list.selected, 45);
  assert.equal(r.app.state.list.items.length, 100);
  const frame = r.app.frame();
  assert.ok(frame.some((l) => l.includes('Article 46 ')), 'the selected row is on screen');
  assert.ok(!frame.some((l) => l.includes('Article 1 ')), 'the top has scrolled away');
  // The second page was asked for with the cursor of the last row of the first.
  assert.ok(r.client.calls.some((c) => c.startsWith('articles') && c.includes('"id":"a50"')));

  await r.press('G');
  await r.press('G');
  assert.equal(r.app.state.list.items.length, 120);
  assert.equal(r.app.state.list.exhausted, true);
  assert.match(r.app.frame()[0]!, /120 articles/);
});

test('Enter opens the article; Esc comes back to the same row', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  const frame = await r.press(`${DOWN}${ENTER}`);
  assert.equal(r.app.state.screen, 'reader');
  assert.match(frame[0]!, /^ Quick Reads {2}Article 2/);
  assert.ok(frame.some((l) => l.trim() === 'Body of article 2.'));
  assert.match(frame[23]!, /esc back/);
  // Bodies are fetched on open, never with the list.
  assert.ok(r.client.calls.includes('article a2'));

  await r.press(ESC);
  assert.equal(r.app.state.screen, 'list');
  assert.equal(r.app.state.list.selected, 1);
});

test('the reader shows the header at once and the body when it arrives', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  r.app.input(ENTER);
  const loading = r.app.frame();
  assert.match(loading[0]!, /Loading/);
  assert.ok(loading.some((l) => l.trim() === 'Article 1'));
  assert.ok(!loading.some((l) => l.includes('Body of article 1.')));
  await r.app.settled();
  assert.ok(r.app.frame().some((l) => l.includes('Body of article 1.')));
});

test('the reader scrolls by line and by page, and says how far along it is', async (t) => {
  const client = library();
  client.account.articles[0]!.content = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}.</p>`).join('');
  const r = await rig(client);
  t.after(() => r.app.stop());
  let frame = await r.press(ENTER);
  assert.ok(frame.some((l) => l.includes('Paragraph 0.')));
  assert.match(frame[0]!, /\d+% $/);

  frame = await r.press(' ');
  assert.equal(r.app.state.reader!.scroll, 20);
  assert.ok(!frame.some((l) => l.includes('Paragraph 0.')));

  await r.press('b');
  assert.equal(r.app.state.reader!.scroll, 0);
  await r.press(`${DOWN}${DOWN}j`);
  assert.equal(r.app.state.reader!.scroll, 3);

  frame = await r.press('G');
  assert.ok(frame.some((l) => l.includes('Paragraph 59.')));
  assert.match(frame[0]!, /100% $/);
  await r.press(DOWN);
  assert.equal(r.app.state.reader!.scroll, r.app.state.reader!.lines.length - 21, 'it does not scroll past the end');
});

test('the article is centred in a wide terminal and rewraps on resize', async (t) => {
  const client = library();
  client.account.articles[0]!.content = `<p>${'word '.repeat(200)}</p>`;
  const r = await rig(client, { cols: 120, rows: 30 });
  t.after(() => r.app.stop());
  let frame = await r.press(ENTER);
  const body = frame.slice(2, -1).filter((l) => l.includes('word'));
  assert.ok(body.every((l) => l.startsWith(' '.repeat(20)) && stringWidth(l) <= 100));

  r.size.cols = 50;
  r.app.resize();
  frame = r.app.frame();
  assert.ok(frame.every((l) => stringWidth(l) <= 50));
  assert.equal(r.app.state.reader!.width, 46);
});

test('a link with no text says so and offers the browser', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press(TAB);
  await r.press(ENTER);
  assert.ok(r.screen().replace(/\s+/g, ' ').includes('Press o to open it in your browser.'));
  await r.press('o');
  assert.deepEqual(r.opened, ['https://example.com/t1']);
});

test('an article that fails to load says why, and Esc still works', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  r.client.failNext.article = new ApiError('not_found', 404, 'Article not found');
  await r.press(ENTER);
  assert.ok(r.screen().includes('Article not found'));
  await r.press(ESC);
  assert.equal(r.app.state.screen, 'list');
});

test('a archives the selected row at once, and u brings it back', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  let frame = await r.press(`${DOWN}a`);
  assert.deepEqual(r.app.state.list.items.map((a) => a.id), ['a1', 'a3']);
  assert.equal(r.app.state.list.selected, 1);
  assert.match(frame[23]!, /Archived: Article 2\. Press u to undo\./);
  assert.ok(r.client.calls.includes('archive a2'));
  assert.notEqual(r.client.account.articles.find((a) => a.id === 'a2')!.archivedAt, null);

  frame = await r.press('u');
  assert.deepEqual(r.app.state.list.items.map((a) => a.id), ['a1', 'a2', 'a3']);
  assert.equal(r.app.state.list.selected, 1);
  assert.match(frame[23]!, /Undone: Article 2\./);
  assert.equal(r.client.account.articles.find((a) => a.id === 'a2')!.archivedAt, null);

  frame = await r.press('u');
  assert.match(frame[23]!, /Nothing to undo\./);
});

test('an archive the server refuses puts the row back', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  r.client.failNext.archive = new ApiError('server', 500, 'The server answered 500.');
  const frame = await r.press('a');
  assert.deepEqual(r.app.state.list.items.map((a) => a.id), ['a1', 'a2', 'a3']);
  assert.match(frame[23]!, /Could not archive that: The server answered 500\./);
  // There is nothing to undo, because nothing happened.
  assert.match((await r.press('u'))[23]!, /Nothing to undo\./);
});

test('archiving the last row leaves an empty queue that says so', async (t) => {
  const r = await rig(library(1));
  t.after(() => r.app.stop());
  const frame = await r.press('a');
  assert.equal(r.app.state.list.selected, -1);
  assert.ok(frame.some((l) => l.includes('Your queue is empty. Press s to save a link.')));
  // Keys that need a selection are harmless without one.
  await r.press(`a${ENTER}oc${DOWN}`);
  assert.equal(r.app.state.screen, 'list');
  assert.deepEqual(r.opened, []);
});

test('a in the reader archives and returns to the list', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press(`${ENTER}a`);
  assert.equal(r.app.state.screen, 'list');
  assert.deepEqual(r.app.state.list.items.map((a) => a.id), ['a2', 'a3']);
  assert.ok(r.client.calls.includes('archive a1'));
});

test('tab cycles Queue, To Do, Archive; numbers jump straight there', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  let frame = await r.press(TAB);
  assert.match(frame[0]!, /Queue {2}\[To Do\] {2}Archive +1 item $/);
  assert.match(frame[2]!, /Try this app +Example · link/);
  assert.match(frame[23]!, /a done/);

  frame = await r.press(TAB);
  assert.match(frame[0]!, /\[Archive\] +1 article $/);
  assert.match(frame[2]!, /Old news/);
  assert.match(frame[23]!, /a unarchive/);

  frame = await r.press(TAB);
  assert.match(frame[0]!, /\[Queue\]/);
  frame = await r.press('\x1b[Z');
  assert.match(frame[0]!, /\[Archive\]/);
  frame = await r.press('2');
  assert.match(frame[0]!, /\[To Do\]/);
});

test('a in the archive returns the article to the queue', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press('3');
  const frame = await r.press('a');
  assert.ok(r.client.calls.includes('unarchive old'));
  assert.match(frame[23]!, /Back in the queue: Old news/);
  assert.ok(frame.some((l) => l.includes('Nothing archived yet.')));
  assert.ok((await r.press('1')).some((l) => l.includes('Old news')));
});

test('a hidden To Do list explains itself instead of erroring', async (t) => {
  const client = library();
  client.account.todoHidden = true;
  const r = await rig(client);
  t.after(() => r.app.stop());
  const frame = await r.press('2');
  assert.ok(frame.some((l) => l.includes('To Do is hidden on this account.')));
  assert.match((await r.press(TAB))[0]!, /\[Archive\]/);
});

test('/ searches, shows what is archived, and Esc returns to the list it left', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press('3');
  let frame = await r.press('/');
  assert.match(frame[23]!, /^ Search: /);
  frame = await r.press('news');
  assert.match(frame[23]!, /^ Search: news/);
  frame = await r.press(ENTER);
  assert.match(frame[0]!, /^ Quick Reads {2}Search: news +1 match $/);
  assert.match(frame[2]!, /Old news +archived · Example/);
  assert.match(frame[23]!, /esc back/);

  frame = await r.press(ESC);
  assert.match(frame[0]!, /\[Archive\]/);
  assert.deepEqual(r.quit, []);
});

test('archiving a search result marks it rather than removing it', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  let frame = await r.press(`/Article 2${ENTER}`);
  assert.match(frame[2]!, /Article 2 +Example/);
  frame = await r.press('a');
  assert.equal(r.app.state.list.items.length, 1);
  assert.match(frame[2]!, /Article 2 +archived · Example/);
  frame = await r.press('a');
  assert.ok(!frame[2]!.includes('archived'));
});

test('a search with no matches says so; an empty search is cancelled', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  let frame = await r.press(`/zzzz${ENTER}`);
  assert.ok(frame.some((l) => l.includes('Nothing matches "zzzz".')));
  await r.press(ESC);
  const before = r.client.calls.length;
  frame = await r.press(`/   ${ENTER}`);
  assert.match(frame[0]!, /\[Queue\]/);
  assert.equal(r.client.calls.length, before);
});

test('the prompt edits like a line: backspace, ctrl-u, ctrl-w, escape', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press('/hello world');
  assert.equal(r.app.state.prompt!.value, 'hello world');
  await r.press('\x7f\x7f');
  assert.equal(r.app.state.prompt!.value, 'hello wor');
  await r.press('\x17');
  assert.equal(r.app.state.prompt!.value, 'hello ');
  await r.press('\x15');
  assert.equal(r.app.state.prompt!.value, '');
  // Keys that are commands elsewhere are just letters here, arrows do nothing.
  await r.press(`qa${UP}${DOWN}`);
  assert.equal(r.app.state.prompt!.value, 'qa');
  assert.deepEqual(r.quit, []);
  await r.press(ESC);
  assert.equal(r.app.state.prompt, null);
  assert.equal(r.app.state.screen, 'list');
});

test('a long prompt value keeps its end in view', async (t) => {
  const r = await rig(library(), { cols: 40, rows: 12 });
  t.after(() => r.app.stop());
  const frame = await r.press(`s${'https://example.com/a/very/long/path/that/does/not/fit'}`);
  assert.ok(stringWidth(frame[11]!) <= 40);
  assert.ok(frame[11]!.includes('does/not/fit'));
});

test('s saves a pasted link to the top of the queue', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press(DOWN);
  let frame = await r.press('s');
  assert.match(frame[23]!, /^ Save link: /);
  frame = await r.press(`example.org/new${ENTER}`);
  assert.ok(r.client.calls.includes('save {"url":"https://example.org/new"}'));
  assert.match(frame[23]!, /Saved to your queue: A Saved Page\./);
  assert.match(frame[2]!, /A Saved Page/);
  // The row that was selected still is.
  assert.equal(r.app.state.list.items[r.app.state.list.selected]!.id, 'a2');
});

test('s in To Do saves to To Do', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  const frame = await r.press(`2shttps://example.org/app${ENTER}`);
  assert.ok(r.client.calls.includes('save {"url":"https://example.org/app","list":"todo"}'));
  assert.match(frame[23]!, /Saved to To Do/);
  assert.equal(r.app.state.list.items.length, 2);
});

test('saving nonsense, a duplicate, or into a failure each says what happened', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  assert.match((await r.press(`snonsense${ENTER}`))[23]!, /nonsense does not look like a web address\./);
  assert.match((await r.press(`shttps://example.com/a1${ENTER}`))[23]!, /Already saved\./);
  r.client.failNext.save = new ApiError('network', null, 'Could not reach https://quickreads.test.');
  assert.match((await r.press(`shttps://example.org/x${ENTER}`))[23]!, /Could not save that: Could not reach/);
  assert.equal(r.app.state.list.items.length, 3);
});

test('h lists highlights; Enter opens the article at that passage', async (t) => {
  const client = library();
  client.account.articles[1]!.content =
    `${Array.from({ length: 40 }, (_, i) => `<p>Filler ${i}.</p>`).join('')}<p>Here is article 2 at last.</p>`;
  const r = await rig(client);
  t.after(() => r.app.stop());
  let frame = await r.press('h');
  assert.match(frame[0]!, /^ Quick Reads {2}Highlights +2 highlights $/);
  assert.deepEqual(frame.slice(2, 8), [
    ' ▸ Article 1 · Example · 2h',
    '   ▎ Body of article 1.',
    '',
    '   Article 2 · Example · 2h',
    '   ▎ article 2',
    '     Note: Worth remembering.',
  ]);

  frame = await r.press(`${DOWN}${ENTER}`);
  assert.equal(r.app.state.screen, 'reader');
  assert.ok(frame.some((l) => l.includes('Here is article 2 at last.')), 'opened at the highlight, not the top');
  assert.ok(r.app.state.reader!.scroll > 0);

  await r.press(ESC);
  assert.equal(r.app.state.screen, 'highlights');
  assert.equal(r.app.state.highlights!.selected, 1);
  await r.press(ESC);
  assert.equal(r.app.state.screen, 'list');
});

test('c copies the link in a list and the passage in highlights', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  assert.match((await r.press('c'))[23]!, /Link copied\./);
  await r.press('h');
  await r.press('c');
  assert.deepEqual(r.copied, ['https://example.com/a1', 'Body of article 1.']);
});

test('o opens the original, or Quick Reads when there is none', async (t) => {
  const client = library();
  client.account.articles[1]!.hasOriginalUrl = false;
  const r = await rig(client);
  t.after(() => r.app.stop());
  await r.press(`o${DOWN}o`);
  assert.deepEqual(r.opened, ['https://example.com/a1', 'https://quickreads.test/app/read/a2']);
});

test('r refreshes in place and keeps the selection on its article', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press(DOWN);
  r.client.account.articles.unshift(article('new', { title: 'Just saved', savedAt: ago(60_000) }));
  const frame = await r.press('r');
  assert.match(frame[2]!, /Just saved/);
  assert.equal(r.app.state.list.items[r.app.state.list.selected]!.id, 'a2');
});

test('a queue that fails to load says why and r tries again', async (t) => {
  const client = library();
  client.failNext.articles = new ApiError('network', null, 'Could not reach https://quickreads.test.');
  const r = await rig(client);
  t.after(() => r.app.stop());
  let frame = r.app.frame();
  assert.ok(frame.some((l) => l.includes('Could not reach https://quickreads.test.')));
  assert.ok(frame.some((l) => l.includes('Press r to try again.')));
  frame = await r.press('r');
  assert.match(frame[2]!, /Article 1/);
});

test('a rejected key says how to fix it', async (t) => {
  const client = library();
  client.failNext.articles = new ApiError('unauthorized', 401, 'The server rejected this API key.');
  const r = await rig(client);
  t.after(() => r.app.stop());
  assert.ok(r.screen().includes('run `quickreads auth`'));
});

test('an answer that arrives after the reader moved on is dropped', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  // Open an article and leave before it loads, then switch lists twice.
  r.app.input(`${ENTER}${ESC}${TAB}${TAB}`);
  await r.app.settled();
  assert.equal(r.app.state.screen, 'list');
  assert.equal(r.app.state.reader, null);
  assert.equal(r.app.state.list.source.kind, 'archive');
  assert.deepEqual(r.app.state.list.items.map((a) => a.id), ['old']);
});

test('the footer drops hints to fit, but never the way out', async (t) => {
  for (const cols of [120, 80, 60, 40, 24]) {
    const r = await rig(library(), { cols, rows: 12 });
    t.after(() => r.app.stop());
    assert.match(r.app.frame()[11]!, /q quit$/, `list at ${cols}`);
    assert.match((await r.press(ENTER))[11]!, /esc back$/, `reader at ${cols}`);
    await r.press(ESC);
    assert.match((await r.press('h'))[11]!, /esc back$/, `highlights at ${cols}`);
  }
  const wide = await rig(library(), { cols: 120, rows: 12 });
  t.after(() => wide.app.stop());
  assert.match(wide.app.frame()[11]!, /h highlights · tab lists · \? keys · q quit$/);
});

test('keys typed before a list has loaded do nothing, rather than act on the old one', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  // 3 switches to the archive; the a arrives before its rows do.
  await r.press('3a');
  assert.ok(!r.client.calls.some((c) => c.startsWith('archive') || c.startsWith('unarchive')));
  assert.deepEqual(r.app.state.list.items.map((a) => a.id), ['old']);
});

test('? shows the keys over any screen and any key dismisses it', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  let frame = await r.press(`${ENTER}?`);
  assert.match(frame[0]!, /Keys/);
  assert.ok(frame.some((l) => l.includes('Undo the last archive')));
  frame = await r.press('q');
  assert.equal(r.app.state.screen, 'reader');
  assert.deepEqual(r.quit, []);
});

test('q quits from the list; in the reader it only goes back', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press(`${ENTER}q`);
  assert.equal(r.app.state.screen, 'list');
  assert.deepEqual(r.quit, []);
  await r.press('q');
  assert.deepEqual(r.quit, [0]);
});

test('ctrl-c quits from anywhere, a prompt included', async (t) => {
  for (const keys of ['', ENTER, 'h', '/typing', '?']) {
    const r = await rig();
    t.after(() => r.app.stop());
    await r.press(`${keys}\x03`);
    assert.deepEqual(r.quit, [0], `after ${JSON.stringify(keys)}`);
  }
});

test('nothing is painted after it stops', async (t) => {
  const r = await rig();
  t.after(() => r.app.stop());
  await r.press('q');
  const painted = r.frames.length;
  await r.press(`${DOWN}${DOWN}a`);
  assert.equal(r.frames.length, painted);
  assert.ok(!r.client.calls.some((c) => c.startsWith('archive')));
});
