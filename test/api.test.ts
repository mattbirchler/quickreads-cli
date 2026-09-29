import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, walkArticles, verifyToken, ApiError } from '../src/api.ts';
import type { Article } from '../src/types.ts';

interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }

function fetchStub(handler: (seen: Seen) => Response | Promise<Response>): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler({
    url: String(url),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  }))) as typeof fetch;
}

function article(id: string, over: Partial<Article> = {}): Article {
  return {
    id, url: `https://example.com/${id}`, title: `Post ${id}`, author: null, siteName: 'Example',
    excerpt: null, wordCount: 500, type: 'article', publishedAt: null,
    savedAt: `2026-09-01T00:00:${id.padStart(2, '0')}.000Z`, archivedAt: null, ...over,
  };
}

const SERVER = 'https://example.test';

test('requests carry the bearer key and parse JSON', async () => {
  let seen: Seen | null = null;
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => { seen = s; return Response.json([]); }));
  assert.deepEqual(await client.articles(), []);
  assert.equal(seen!.headers['authorization'], 'Bearer rl_x');
  assert.equal(seen!.url, `${SERVER}/api/articles?limit=50&includeContent=false`);
});

test('a list never asks for article bodies', async () => {
  const urls: string[] = [];
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => { urls.push(s.url); return Response.json([]); }));
  await client.articles({ archived: true, list: 'todo', limit: 10 });
  assert.ok(urls[0]!.includes('includeContent=false'));
  assert.ok(urls[0]!.includes('archived=true'));
  assert.ok(urls[0]!.includes('list=todo'));
});

test('the cursor matches the list: savedAt for the queue, archivedAt for the archive', async () => {
  const urls: string[] = [];
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => { urls.push(s.url); return Response.json([]); }));
  const before = { at: '2026-09-01T00:00:00.000Z', id: 'abc' };
  await client.articles({ before });
  await client.articles({ archived: true, before });
  assert.ok(urls[0]!.includes('beforeSavedAt=2026-09-01T00%3A00%3A00.000Z&beforeId=abc'));
  assert.ok(urls[1]!.includes('beforeArchivedAt=2026-09-01T00%3A00%3A00.000Z&beforeId=abc'));
});

test('walkArticles pages with the cursor until it has enough', async () => {
  const all = Array.from({ length: 130 }, (_, i) => article(String(130 - i)));
  const urls: string[] = [];
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => {
    urls.push(s.url);
    const q = new URL(s.url).searchParams;
    const limit = Number(q.get('limit'));
    const beforeId = q.get('beforeId');
    const start = beforeId === null ? 0 : all.findIndex((a) => a.id === beforeId) + 1;
    return Response.json(all.slice(start, start + limit));
  }));
  const got = await walkArticles(client, {}, 120);
  assert.equal(got.length, 120);
  assert.equal(urls.length, 2);
  assert.ok(urls[1]!.includes('beforeId=31'));
  assert.deepEqual(got.map((a) => a.id), all.slice(0, 120).map((a) => a.id));
});

test('walkArticles stops at the end of a short list', async () => {
  let calls = 0;
  const client = createClient(SERVER, 'rl_x', fetchStub(() => { calls += 1; return Response.json([article('1')]); }));
  assert.equal((await walkArticles(client, {}, 25)).length, 1);
  assert.equal(calls, 1);
});

test('save posts the URL and marks itself as an API save', async () => {
  let seen: Seen | null = null;
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => { seen = s; return Response.json(article('1')); }));
  const result = await client.save('https://example.com/1', { list: 'todo', title: 'Try this' });
  assert.equal(seen!.method, 'POST');
  assert.equal(seen!.url, `${SERVER}/api/articles`);
  assert.deepEqual(seen!.body, { url: 'https://example.com/1', source: 'api', list: 'todo', title: 'Try this' });
  assert.equal(result.alreadySaved, false);
});

test('saving something already saved is an answer, not an error', async () => {
  const client = createClient(SERVER, 'rl_x', fetchStub(() => Response.json({
    error: 'You have already saved this article',
    articleId: 'abc123',
    readerUrl: 'https://quickreads.app/app/read/abc123',
  }, { status: 409 })));
  assert.deepEqual(await client.save('https://example.com/1'), {
    alreadySaved: true,
    articleId: 'abc123',
    readerUrl: 'https://quickreads.app/app/read/abc123',
  });
});

test('search sends the words and the tag', async () => {
  let url = '';
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => { url = s.url; return Response.json([]); }));
  await client.search({ query: 'apple silicon', tagId: 'tag1', limit: 5 });
  assert.equal(url, `${SERVER}/api/articles/search?limit=5&q=apple+silicon&tag=tag1`);
});

test('archive and unarchive post to the article', async () => {
  const seen: string[] = [];
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => {
    seen.push(`${s.method} ${new URL(s.url).pathname}`);
    return Response.json({ success: true });
  }));
  await client.archive('abc');
  await client.unarchive('abc');
  assert.deepEqual(seen, ['POST /api/articles/abc/archive', 'POST /api/articles/abc/unarchive']);
});

test('highlights come back as a page with a total', async () => {
  let url = '';
  const client = createClient(SERVER, 'rl_x', fetchStub((s) => {
    url = s.url;
    return Response.json({ highlights: [], total: 42 });
  }));
  const page = await client.highlights({ limit: 10, offset: 20 });
  assert.equal(url, `${SERVER}/api/highlights?limit=10&offset=20`);
  assert.equal(page.total, 42);
});

test('verifyToken returns the account behind the key', async () => {
  const account = await verifyToken(SERVER, 'rl_x', fetchStub((s) => {
    assert.ok(s.url.endsWith('/api/me'));
    return Response.json({ id: 'u1', email: 'reader@example.test', tier: 'pro' });
  }));
  assert.equal(account.email, 'reader@example.test');
});

test('a 401 is an unauthorized ApiError', async () => {
  const client = createClient(SERVER, 'rl_x', fetchStub(() =>
    Response.json({ error: 'Invalid API key' }, { status: 401 })));
  await assert.rejects(client.articles(), (err: unknown) =>
    err instanceof ApiError && err.kind === 'unauthorized');
});

test('the server\'s own sentence is the error message', async () => {
  const client = createClient(SERVER, 'rl_x', fetchStub(() =>
    Response.json({ error: 'Article not found' }, { status: 404 })));
  await assert.rejects(client.article('nope'), (err: unknown) =>
    err instanceof ApiError && err.kind === 'not_found' && err.message === 'Article not found');
});

test('an error page with no JSON still reports the status', async () => {
  const client = createClient(SERVER, 'rl_x', fetchStub(() =>
    new Response('<html>Bad gateway</html>', { status: 502 })));
  await assert.rejects(client.articles(), (err: unknown) =>
    err instanceof ApiError && err.kind === 'server' && err.message.includes('502'));
});

test('a dead connection is a network error, not a crash', async () => {
  const client = createClient(SERVER, 'rl_x', (() =>
    Promise.reject(new TypeError('fetch failed'))) as typeof fetch);
  await assert.rejects(client.articles(), (err: unknown) =>
    err instanceof ApiError && err.kind === 'network');
});

test('reader links point into the web app', () => {
  assert.equal(createClient(SERVER, 'rl_x').readerUrl('abc'), `${SERVER}/app/read/abc`);
});
