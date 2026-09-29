// A Quick Reads account that lives in memory, and a terminal that writes to
// arrays. Between them a command can be run start to finish with nothing real
// on either side of it.
import type { Client, ListParams, SaveResult } from '../../src/api.ts';
import { ApiError } from '../../src/api.ts';
import type { Io } from '../../src/commands.ts';
import type { Flags } from '../../src/cli.ts';
import type { Ref } from '../../src/refs.ts';
import type { Article, Highlight, Tag } from '../../src/types.ts';

export const NOW = new Date('2026-09-29T12:00:00Z');

export function article(id: string, over: Partial<Article> = {}): Article {
  return {
    id, url: `https://example.com/${id}`, hasOriginalUrl: true, title: `Post ${id}`, author: null,
    siteName: 'Example', content: `<p>Body of ${id}.</p>`, excerpt: null, wordCount: 476, type: 'article',
    list: 'queue', publishedAt: null, savedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    archivedAt: null, ...over,
  };
}

export function highlight(id: string, articleId: string, text: string, over: Partial<Highlight> = {}): Highlight {
  return {
    id, articleId, text, note: null, createdAt: new Date(NOW.getTime() - 7_200_000).toISOString(),
    articleTitle: `Post ${articleId}`, siteName: 'Example', ...over,
  };
}

export interface FakeAccount {
  articles: Article[];
  highlights: Highlight[];
  tags: Tag[];
  // article id -> tag ids
  tagged: Record<string, string[]>;
  todoHidden: boolean;
}

export interface FakeClient extends Client {
  account: FakeAccount;
  calls: string[];
  // Make the next call to this method fail.
  failNext: Partial<Record<keyof Client, Error>>;
}

export function fakeClient(seed: Partial<FakeAccount> = {}): FakeClient {
  const account: FakeAccount = { articles: [], highlights: [], tags: [], tagged: {}, todoHidden: false, ...seed };
  const calls: string[] = [];
  const failNext: FakeClient['failNext'] = {};

  const called = (name: keyof Client, detail = ''): void => {
    calls.push(detail === '' ? name : `${name} ${detail}`);
    const failure = failNext[name];
    if (failure !== undefined) {
      delete failNext[name];
      throw failure;
    }
  };
  const find = (id: string): Article => {
    const found = account.articles.find((a) => a.id === id);
    if (found === undefined) throw new ApiError('not_found', 404, 'Article not found');
    return found;
  };
  const bare = ({ content: _, ...rest }: Article): Article => rest;

  return {
    account,
    calls,
    failNext,
    serverUrl: 'https://quickreads.test',
    async me() {
      called('me');
      return { id: 'u1', email: 'reader@example.test', tier: 'pro' };
    },
    async articles(params: ListParams = {}) {
      called('articles', JSON.stringify(params));
      const list = params.list ?? 'queue';
      if (list === 'todo' && account.todoHidden) throw new ApiError('forbidden', 403, 'The Todo list is not available on this account');
      const archived = params.archived === true;
      let rows = account.articles.filter((a) => (a.list ?? 'queue') === list && (a.archivedAt !== null) === archived);
      if (params.before !== undefined) {
        const at = rows.findIndex((a) => a.id === params.before!.id);
        rows = rows.slice(at + 1);
      }
      return rows.slice(0, params.limit ?? 50).map(bare);
    },
    async article(id) {
      called('article', id);
      return find(id);
    },
    async save(url, options = {}): Promise<SaveResult> {
      called('save', JSON.stringify({ url, ...options }));
      const existing = account.articles.find((a) => a.url === url);
      if (existing !== undefined) {
        return { alreadySaved: true, articleId: existing.id, readerUrl: `https://quickreads.test/app/read/${existing.id}` };
      }
      const todo = options.list === 'todo' && !account.todoHidden;
      const saved = article(`saved${account.articles.length + 1}`, {
        url,
        title: todo && options.title !== undefined ? options.title : 'A Saved Page',
        list: todo ? 'todo' : 'queue',
        ...(todo ? { type: 'link', content: null, wordCount: 0 } : {}),
      });
      account.articles.unshift(saved);
      return { alreadySaved: false, article: saved };
    },
    async saveText(text, title) {
      called('saveText', JSON.stringify({ text, title }));
      const saved = article(`text${account.articles.length + 1}`, {
        url: 'https://quickreads.test/t/x', hasOriginalUrl: false, siteName: null,
        title: title ?? text.split('\n')[0]!.replace(/^#\s*/, ''), content: `<p>${text}</p>`,
      });
      account.articles.unshift(saved);
      return saved;
    },
    async search(params) {
      called('search', JSON.stringify(params));
      const words = (params.query ?? '').toLowerCase();
      return account.articles
        .filter((a) => words === '' || `${a.title} ${a.content}`.toLowerCase().includes(words))
        .filter((a) => params.tagId === undefined || (account.tagged[a.id] ?? []).includes(params.tagId))
        .slice(0, params.limit ?? 50);
    },
    async archive(id) {
      called('archive', id);
      find(id).archivedAt = NOW.toISOString();
    },
    async unarchive(id) {
      called('unarchive', id);
      find(id).archivedAt = null;
    },
    async highlights(params = {}) {
      called('highlights', JSON.stringify(params));
      const offset = params.offset ?? 0;
      return {
        highlights: account.highlights.slice(offset, offset + (params.limit ?? 50)),
        total: account.highlights.length,
      };
    },
    async articleHighlights(id) {
      called('articleHighlights', id);
      return account.highlights.filter((h) => h.articleId === id);
    },
    async tags() {
      called('tags');
      return account.tags;
    },
    readerUrl: (id) => `https://quickreads.test/app/read/${id}`,
  };
}

export interface FakeIo extends Io {
  stdout: string[];
  stderr: string[];
  paged: string[][];
  opened: string[];
  stored: Ref[] | null;
  stdin: string;
}

export function fakeIo(over: Partial<FakeIo> = {}): FakeIo {
  const io: FakeIo = {
    stdout: [],
    stderr: [],
    paged: [],
    opened: [],
    stored: null,
    stdin: '',
    isTTY: false,
    stdinIsTTY: true,
    cols: 80,
    rows: 24,
    out: (line) => { io.stdout.push(...line.split('\n')); },
    err: (line) => { io.stderr.push(...line.split('\n')); },
    now: () => NOW,
    page: async (lines) => { io.paged.push(lines); },
    open: (url) => { io.opened.push(url); },
    readStdin: async () => io.stdin,
    refs: {
      load: () => io.stored,
      save: (refs) => { io.stored = refs; },
    },
    ...over,
  };
  return io;
}

export function flags(over: Partial<Flags> = {}): Flags {
  return {
    json: false, plain: false, archived: false, todo: false, text: false, noPager: false,
    limit: null, width: null, tag: null, title: null, server: null, token: null, ...over,
  };
}
