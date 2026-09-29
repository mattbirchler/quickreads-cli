import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env['NO_COLOR'] = '1';

import * as commands from '../src/commands.ts';
import { ApiError } from '../src/api.ts';
import { stringWidth } from '../src/ansi.ts';
import { article, highlight, fakeClient, fakeIo, flags, NOW, type FakeClient, type FakeIo } from './helpers/fakes.ts';
import type { Flags } from '../src/cli.ts';

const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function library(): FakeClient {
  return fakeClient({
    articles: [
      article('a1', { title: 'Native app propaganda', siteName: 'Birchtree', wordCount: 1428, savedAt: ago(2 * HOUR) }),
      article('a2', { title: 'A deep dive into HDR', siteName: 'Six Colors', wordCount: 2856, savedAt: ago(5 * HOUR), readProgress: 0.5 }),
      article('a3', { title: 'Old news', archivedAt: ago(HOUR), savedAt: ago(48 * HOUR) }),
      article('t1', { title: 'Try this app', list: 'todo', type: 'link', content: null, wordCount: 0 }),
    ],
    highlights: [
      highlight('h1', 'a1', 'The details matter more than the platform.', { articleTitle: 'Native app propaganda', siteName: 'Birchtree' }),
      highlight('h2', 'a2', 'HDR is a mess.', { articleTitle: 'A deep dive into HDR', note: 'Agreed, sadly.' }),
    ],
    tags: [{ id: 'tag1', name: 'Tech', color: 'blue', articleCount: 1 }],
    tagged: { a2: ['tag1'] },
  });
}

async function run(
  name: keyof typeof commands.COMMANDS,
  args: string[] = [],
  f: Partial<Flags> = {},
  client: FakeClient = library(),
  io: FakeIo = fakeIo(),
): Promise<{ code: number; io: FakeIo; client: FakeClient }> {
  const code = await commands.COMMANDS[name]!({ client, io, flags: flags(f), args });
  return { code, io, client };
}

test('list prints the queue as numbered rows and remembers them', async () => {
  const { code, io } = await run('list');
  assert.equal(code, 0);
  assert.equal(io.stdout.length, 2);
  assert.match(io.stdout[0]!, /^ 1 {2}Native app propaganda +Birchtree · 6 min · 2h$/);
  assert.match(io.stdout[1]!, /^ 2 {2}A deep dive into HDR +Six Colors · 12 min · 50% · 5h$/);
  assert.deepEqual(io.stored, [
    { id: 'a1', title: 'Native app propaganda' },
    { id: 'a2', title: 'A deep dive into HDR' },
  ]);
});

test('rows fill the terminal width exactly and no more', async () => {
  for (const cols of [60, 80, 120]) {
    const { io } = await run('list', [], {}, library(), fakeIo({ cols }));
    assert.ok(io.stdout.every((l) => stringWidth(l) === cols - 1), `at ${cols} columns`);
  }
});

test('a narrow terminal keeps the title and lets the meta go', async () => {
  const { io } = await run('list', [], {}, library(), fakeIo({ cols: 30 }));
  assert.ok(io.stdout.every((l) => stringWidth(l) <= 30));
  assert.ok(io.stdout[0]!.includes('Native app propaganda'));
  assert.ok(!io.stdout[0]!.includes('Birchtree'));
});

test('list --archived and --todo ask for the other lists', async () => {
  const archived = await run('list', [], { archived: true });
  assert.match(archived.io.stdout[0]!, /Old news/);
  const todo = await run('list', [], { todo: true });
  assert.match(todo.io.stdout[0]!, /Try this app +Example · link/);
});

test('list --limit stops there', async () => {
  const { io, client } = await run('list', [], { limit: 1 });
  assert.equal(io.stdout.length, 1);
  assert.ok(client.calls[0]!.includes('"limit":1'));
});

test('an empty queue says so and suggests a first step', async () => {
  const { io } = await run('list', [], {}, fakeClient());
  assert.deepEqual(io.stdout, ['Your queue is empty. Save something with `quickreads save <url>`.']);
});

test('--json is one object per line and --plain is tab-separated', async () => {
  const json = await run('list', [], { json: true });
  assert.deepEqual(json.io.stdout.map((l) => JSON.parse(l).id), ['a1', 'a2']);
  const plain = await run('list', [], { plain: true });
  assert.equal(plain.io.stdout[0], `a1\t${ago(2 * HOUR)}\tBirchtree\tNative app propaganda\thttps://example.com/a1`);
  // An empty result in a pipe is no output, not a sentence.
  assert.deepEqual((await run('list', [], { plain: true }, fakeClient())).io.stdout, []);
});

test('hints only appear for a person at a terminal', async () => {
  const piped = await run('list');
  assert.ok(!piped.io.stdout.join('\n').includes('quickreads read'));
  const tty = await run('list', [], {}, library(), fakeIo({ isTTY: true }));
  assert.ok(tty.io.stdout.join('\n').includes('quickreads read <number>'));
});

test('read takes a row number from the last listing', async () => {
  const io = fakeIo();
  const client = library();
  await run('list', [], {}, client, io);
  io.stdout.length = 0;
  const { code } = await run('read', ['2'], {}, client, io);
  assert.equal(code, 0);
  assert.equal(io.stdout[0], 'A deep dive into HDR');
  assert.ok(io.stdout.includes('Body of a2.'));
  assert.ok(client.calls.includes('article a2'));
});

test('read takes an id or a Quick Reads link just as well', async () => {
  assert.equal((await run('read', ['a1'])).io.stdout[0], 'Native app propaganda');
  assert.equal((await run('read', ['https://quickreads.app/app/read/a1'])).io.stdout[0], 'Native app propaganda');
});

test('read explains a number it cannot place', async () => {
  const none = await run('read', ['3']);
  assert.equal(none.code, 2);
  assert.match(none.io.stderr[0]!, /Run `quickreads list` first/);

  const io = fakeIo();
  await run('list', [], {}, library(), io);
  const beyond = await run('read', ['9'], {}, library(), io);
  assert.equal(beyond.code, 2);
  assert.match(beyond.io.stderr[0]!, /had 2 rows; there is no 9/);

  assert.equal((await run('read', [])).code, 2);
});

test('read pages a long article at a terminal and prints a short one', async () => {
  const long = library();
  long.account.articles[0]!.content = '<p>Paragraph.</p>'.repeat(40);
  const paged = await run('read', ['a1'], {}, long, fakeIo({ isTTY: true }));
  assert.equal(paged.io.paged.length, 1);
  assert.deepEqual(paged.io.stdout, []);
  assert.ok(paged.io.paged[0]!.every((l) => l === '' || l.startsWith('  ')), 'paged text has a margin');

  const short = await run('read', ['a1'], {}, library(), fakeIo({ isTTY: true }));
  assert.equal(short.io.paged.length, 0);

  const unpaged = await run('read', ['a1'], { noPager: true }, long, fakeIo({ isTTY: true }));
  assert.equal(unpaged.io.paged.length, 0);
  assert.ok(unpaged.io.stdout.length > 40);
});

test('read marks the passages that were highlighted, and survives losing them', async () => {
  const client = library();
  client.account.articles[0]!.content = '<p>The details matter more than the platform. Truly.</p>';
  const { io } = await run('read', ['a1'], {}, client);
  assert.ok(io.stdout.includes('The details matter more than the platform. Truly.'));

  const broken = library();
  broken.failNext.articleHighlights = new ApiError('server', 500, 'boom');
  const { code, io: io2 } = await run('read', ['a1'], {}, broken);
  assert.equal(code, 0);
  assert.equal(io2.stdout[0], 'Native app propaganda');
});

test('read shows the article\'s tags, and survives losing them', async () => {
  const { io } = await run('read', ['a2']);
  assert.ok(io.stdout.includes('#Tech'));
  assert.ok(!(await run('read', ['a1'])).io.stdout.some((l) => l.startsWith('#')));

  const broken = library();
  broken.failNext.articleTags = new ApiError('server', 500, 'boom');
  const lost = await run('read', ['a2'], {}, broken);
  assert.equal(lost.code, 0);
  assert.ok(lost.io.stdout.includes('Body of a2.'));
});

test('read --width wraps where it is told', async () => {
  const client = library();
  client.account.articles[0]!.content = `<p>${'word '.repeat(50)}</p>`;
  const { io } = await run('read', ['a1'], { width: 30 }, client);
  assert.ok(io.stdout.every((l) => stringWidth(l) <= 30));
});

test('read --json is the article as the API sent it', async () => {
  const { io } = await run('read', ['a1'], { json: true });
  assert.equal(JSON.parse(io.stdout[0]!).content, '<p>Body of a1.</p>');
});

test('a link with no text says how to open it', async () => {
  const { io } = await run('read', ['t1']);
  assert.ok(io.stdout.join(' ').includes('Open it with `quickreads open t1`.'));
});

test('save puts a URL in the queue', async () => {
  const { code, io, client } = await run('save', ['https://example.org/new']);
  assert.equal(code, 0);
  assert.deepEqual(io.stdout, ['✓ Saved to your queue: A Saved Page']);
  assert.equal(client.calls[0], 'save {"url":"https://example.org/new"}');
});

test('save accepts an address typed without its scheme', async () => {
  const { client } = await run('save', ['example.org/new']);
  assert.equal(client.calls[0], 'save {"url":"https://example.org/new"}');
});

test('save refuses what is not an address, before asking the server', async () => {
  const { code, io, client } = await run('save', ['nonsense']);
  assert.equal(code, 1);
  assert.match(io.stderr[0]!, /does not look like a web address/);
  assert.deepEqual(client.calls, []);
  assert.equal((await run('save', ['ftp://example.org/file'])).code, 1);
});

test('save --todo with a title lands in To Do under that title', async () => {
  const { io, client } = await run('save', ['https://example.org/app'], { todo: true, title: 'Try this' });
  assert.deepEqual(io.stdout, ['✓ Saved to To Do: Try this']);
  assert.equal(client.account.articles[0]!.list, 'todo');
});

test('save says so when a hidden To Do list sent it to the queue', async () => {
  const client = library();
  client.account.todoHidden = true;
  const { io } = await run('save', ['https://example.org/app'], { todo: true }, client);
  assert.equal(io.stdout[0], '✓ Saved to your queue: A Saved Page');
  assert.match(io.stdout[1]!, /To Do is hidden on this account/);
});

test('saving something twice points at the copy you have', async () => {
  const { code, io } = await run('save', ['https://example.com/a1']);
  assert.equal(code, 0);
  assert.deepEqual(io.stdout, ['• Already saved: https://example.com/a1', '  https://quickreads.test/app/read/a1']);
});

test('save takes several URLs and keeps going past a bad one', async () => {
  const client = library();
  const { code, io } = await run('save', ['https://example.org/1', 'nonsense', 'https://example.org/2'], {}, client);
  assert.equal(code, 1);
  assert.equal(io.stdout.length, 2);
  assert.equal(io.stderr.length, 1);
  assert.equal(client.calls.length, 2);
});

test('save reads URLs from a pipe', async () => {
  const io = fakeIo({ stdinIsTTY: false, stdin: 'https://example.org/1\nhttps://example.org/2\n' });
  const { code, client } = await run('save', [], {}, library(), io);
  assert.equal(code, 0);
  assert.equal(client.calls.length, 2);
});

test('save with nothing to save asks what was meant', async () => {
  const { code, io } = await run('save', []);
  assert.equal(code, 2);
  assert.match(io.stderr[0]!, /Save what\?/);
});

test('save --text saves what was piped in', async () => {
  const io = fakeIo({ stdinIsTTY: false, stdin: '# My notes\n\nSome thoughts.' });
  const { code, client } = await run('save', [], { text: true }, library(), io);
  assert.equal(code, 0);
  assert.deepEqual(io.stdout, ['✓ Saved to your queue: My notes']);
  assert.ok(client.calls[0]!.startsWith('saveText'));
  // With nothing piped there is nothing to read; say how instead of hanging.
  assert.equal((await run('save', [], { text: true })).code, 2);
});

test('a failed save reports the server\'s reason', async () => {
  const client = library();
  client.failNext.save = new ApiError('bad_request', 400, 'Invalid URL');
  await assert.rejects(run('save', ['https://example.org/x'], {}, client), /Invalid URL/);
});

test('search finds by words, flags what is archived, and remembers rows', async () => {
  const { io, client } = await run('search', ['old', 'news']);
  assert.equal(client.calls[0], 'search {"query":"old news","limit":25}');
  assert.match(io.stdout[0]!, /^ 1 {2}Old news +archived · Example · 2 min · 1h$/);
  assert.deepEqual(io.stored, [{ id: 'a3', title: 'Old news' }]);
});

test('search --tag resolves the name, with or without words', async () => {
  const { io, client } = await run('search', [], { tag: '#tech' });
  assert.deepEqual(client.calls, ['tags', 'search {"tagId":"tag1","limit":25}']);
  assert.match(io.stdout[0]!, /A deep dive into HDR/);
});

test('search names your tags when it cannot find the one you asked for', async () => {
  const { code, io } = await run('search', [], { tag: 'nope' });
  assert.equal(code, 1);
  assert.equal(io.stderr[0], 'No tag called "nope". Yours are: Tech.');
});

test('search with nothing to look for is a usage error', async () => {
  assert.equal((await run('search', [])).code, 2);
  assert.deepEqual((await run('search', ['zzz'])).io.stdout, ['Nothing matches "zzz".']);
});

test('highlights lists them newest first with their articles and notes', async () => {
  const { io } = await run('highlights');
  assert.deepEqual(io.stdout, [
    ' 1  Native app propaganda · Birchtree · 2h',
    '    ▎ The details matter more than the platform.',
    '',
    ' 2  A deep dive into HDR · Example · 2h',
    '    ▎ HDR is a mess.',
    '      Note: Agreed, sadly.',
  ]);
});

test('a highlight row number opens its article', async () => {
  const io = fakeIo();
  const client = library();
  await run('highlights', [], {}, client, io);
  io.stdout.length = 0;
  await run('read', ['2'], {}, client, io);
  assert.equal(io.stdout[0], 'A deep dive into HDR');
});

test('highlights for one article', async () => {
  const { io } = await run('highlights', ['a2']);
  assert.deepEqual(io.stdout, [
    'A deep dive into HDR  1 highlight',
    '',
    ' ▎ HDR is a mess.',
    '   Note: Agreed, sadly.',
  ]);
  assert.deepEqual((await run('highlights', ['a3'])).io.stdout, ['No highlights in Old news.']);
});

test('highlights says when there are more than it showed', async () => {
  const { io } = await run('highlights', [], { limit: 1 });
  assert.equal(io.stdout.at(-1), ' Showing 1 of 2. Ask for more with --limit.');
});

test('highlights wrap inside the terminal', async () => {
  const client = library();
  client.account.highlights[0]!.text = 'long '.repeat(60).trim();
  const { io } = await run('highlights', [], {}, client, fakeIo({ cols: 50 }));
  assert.ok(io.stdout.every((l) => stringWidth(l) <= 50));
});

test('highlights --plain keeps each one on its own line', async () => {
  const client = library();
  client.account.highlights[0]!.text = 'Two\nlines';
  const { io } = await run('highlights', [], { plain: true }, client);
  assert.equal(io.stdout.length, 2);
  assert.equal(io.stdout[0]!.split('\t')[2], 'Two lines');
});

test('archive and unarchive say what they moved', async () => {
  const io = fakeIo();
  const client = library();
  await run('list', [], {}, client, io);
  io.stdout.length = 0;
  await run('archive', ['1', '2'], {}, client, io);
  assert.deepEqual(io.stdout, ['✓ Archived: Native app propaganda', '✓ Archived: A deep dive into HDR']);
  assert.ok(client.account.articles.slice(0, 2).every((a) => a.archivedAt !== null));

  io.stdout.length = 0;
  await run('unarchive', ['a1'], {}, client, io);
  assert.deepEqual(io.stdout, ['✓ Back in the queue: Native app propaganda']);
  assert.equal(client.account.articles[0]!.archivedAt, null);
});

test('archive changes nothing when one of its arguments is wrong', async () => {
  const io = fakeIo();
  const client = library();
  await run('list', [], {}, client, io);
  const { code } = await run('archive', ['1', '7'], {}, client, io);
  assert.equal(code, 2);
  assert.ok(!client.calls.some((c) => c.startsWith('archive')));
});

test('open goes to the original page', async () => {
  const { io } = await run('open', ['a1']);
  assert.deepEqual(io.opened, ['https://example.com/a1']);
});

test('open goes to Quick Reads when there is no original page', async () => {
  const client = library();
  client.account.articles[0]!.hasOriginalUrl = false;
  const { io } = await run('open', ['a1'], {}, client);
  assert.deepEqual(io.opened, ['https://quickreads.test/app/read/a1']);
});

test('tags lists names and counts', async () => {
  assert.deepEqual((await run('tags')).io.stdout, [' ● Tech  1 article']);
  assert.deepEqual((await run('tags', [], {}, fakeClient())).io.stdout, ['No tags yet.']);
});

test('whoami names the account', async () => {
  assert.deepEqual((await run('whoami')).io.stdout, ['reader@example.test  pro · https://quickreads.test']);
});

test('slow work says what it is doing, and always says when it has stopped', async () => {
  const saved = await run('save', ['https://example.org/new']);
  assert.deepEqual(saved.io.waits, ['Saving https://example.org/new']);
  assert.equal(saved.io.finished, 1);

  const io = fakeIo();
  const client = library();
  await run('list', [], {}, client, io);
  await run('read', ['1'], {}, client, io);
  await run('archive', ['1', '2'], {}, client, io);
  assert.deepEqual(io.waits, [
    'Loading',
    'Opening Native app propaganda',
    'Archiving Native app propaganda',
    'Archiving A deep dive into HDR',
  ]);
  assert.equal(io.finished, 4);

  // A failure must not leave the spinner running.
  const broken = library();
  broken.failNext.search = new ApiError('server', 500, 'boom');
  const failing = fakeIo();
  await assert.rejects(run('search', ['x'], {}, broken, failing));
  assert.equal(failing.finished, failing.waits.length);

  const paged = library();
  paged.failNext.highlights = new ApiError('server', 500, 'boom');
  const failingToo = fakeIo();
  await assert.rejects(run('highlights', [], {}, paged, failingToo));
  assert.equal(failingToo.finished, failingToo.waits.length);
});

test('machine output carries no marks', async () => {
  const plain = await run('save', ['https://example.org/new'], { plain: true });
  assert.ok(!plain.io.stdout.join('').includes('✓'));
  const json = await run('archive', ['a1'], { json: true });
  assert.deepEqual(json.io.stdout.map((l) => JSON.parse(l)), [{ id: 'a1', archived: true }]);
});
