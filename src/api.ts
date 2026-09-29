// The one place HTTP happens. Callers get JSON or an ApiError whose `kind`
// they can switch on; nobody else parses status codes. Every endpoint here is
// one the public docs describe (https://quickreads.app/docs).
import type { Account, Article, ArticleList, Highlight, HighlightsPage, Tag } from './types.ts';

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'rate_limited'
  | 'server'
  | 'network';

export class ApiError extends Error {
  kind: ApiErrorKind;
  status: number | null;
  // The parsed error body. A 409 on save carries the existing article's
  // `articleId` and `readerUrl` here, which is what lets the caller point at
  // the saved copy instead of just reporting a failure.
  body: Record<string, unknown>;

  constructor(kind: ApiErrorKind, status: number | null, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

const KIND_BY_STATUS: Record<number, ApiErrorKind> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

// A save waits on the server fetching and parsing someone else's website, so
// it gets far longer than a read does.
const READ_TIMEOUT_MS = 20_000;
const SAVE_TIMEOUT_MS = 90_000;

export type Requester = <T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) => Promise<T>;

export function createRequester(serverUrl: string, token: string, fetchImpl: typeof fetch = fetch): Requester {
  return async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${serverUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new ApiError('network', null, timedOut
        ? `${serverUrl} took too long to answer.`
        : `Could not reach ${serverUrl}.`);
    }

    if (res.ok) {
      try {
        return await res.json() as T;
      } catch {
        throw new ApiError('server', res.status, 'The server sent something that was not JSON.');
      }
    }

    // Error bodies are { "error": "A sentence for a person" }.
    let parsed: Record<string, unknown> = {};
    try {
      const json: unknown = await res.json();
      if (json !== null && typeof json === 'object') parsed = json as Record<string, unknown>;
    } catch {
      // An HTML error page from a proxy has no body worth reading.
    }
    const said = typeof parsed['error'] === 'string' ? parsed['error'] : null;
    const kind = KIND_BY_STATUS[res.status] ?? 'server';
    if (kind === 'unauthorized') {
      throw new ApiError(kind, res.status, 'The server rejected this API key.', parsed);
    }
    throw new ApiError(kind, res.status, said ?? `The server answered ${res.status}.`, parsed);
  };
}

// What `quickreads auth` calls to prove a pasted key works. /api/me answers
// even for an account with no subscription, so a lapsed user still gets a
// truthful "connected" plus their tier.
export async function verifyToken(serverUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Account> {
  return createRequester(serverUrl, token, fetchImpl)<Account>('GET', '/api/me');
}

export interface ListParams {
  // The archive instead of the queue (or done items instead of open To Dos).
  archived?: boolean;
  list?: ArticleList;
  limit?: number;
  // Where the previous page ended: its last article's timestamp and id.
  before?: { at: string; id: string };
}

export interface SaveOptions {
  list?: ArticleList;
  title?: string;
}

// A URL that is already in the library is an answer, not a failure: the
// caller gets the existing article to point at.
export type SaveResult =
  | { alreadySaved: false; article: Article }
  | { alreadySaved: true; articleId: string | null; readerUrl: string | null };

export interface Client {
  serverUrl: string;
  me(): Promise<Account>;
  /** One page of a list, newest first, without article bodies. */
  articles(params?: ListParams): Promise<Article[]>;
  /** One article with its full content. */
  article(id: string): Promise<Article>;
  save(url: string, options?: SaveOptions): Promise<SaveResult>;
  saveText(text: string, title?: string): Promise<Article>;
  search(params: { query?: string; tagId?: string; limit?: number }): Promise<Article[]>;
  archive(id: string): Promise<void>;
  unarchive(id: string): Promise<void>;
  highlights(params?: { limit?: number; offset?: number }): Promise<HighlightsPage>;
  articleHighlights(id: string): Promise<Highlight[]>;
  tags(): Promise<Tag[]>;
  /** Where this article lives in the Quick Reads web app. */
  readerUrl(id: string): string;
}

export const PAGE_SIZE = 50;

export function createClient(serverUrl: string, token: string, fetchImpl: typeof fetch = fetch): Client {
  const request = createRequester(serverUrl, token, fetchImpl);
  const at = (id: string) => `/api/articles/${encodeURIComponent(id)}`;

  return {
    serverUrl,
    me: () => request<Account>('GET', '/api/me'),

    articles(params = {}) {
      const archived = params.archived === true;
      // Bodies stay on the server until an article is opened: a page of
      // articles with content can run to megabytes.
      const q = new URLSearchParams({ limit: String(params.limit ?? PAGE_SIZE), includeContent: 'false' });
      if (archived) q.set('archived', 'true');
      if (params.list !== undefined && params.list !== 'queue') q.set('list', params.list);
      if (params.before !== undefined) {
        q.set(archived ? 'beforeArchivedAt' : 'beforeSavedAt', params.before.at);
        q.set('beforeId', params.before.id);
      }
      return request<Article[]>('GET', `/api/articles?${q.toString()}`);
    },

    article: (id) => request<Article>('GET', at(id)),

    async save(url, options = {}) {
      const body: Record<string, unknown> = { url, source: 'api' };
      if (options.list !== undefined) body['list'] = options.list;
      if (options.title !== undefined) body['title'] = options.title;
      try {
        const article = await request<Article>('POST', '/api/articles', body, SAVE_TIMEOUT_MS);
        return { alreadySaved: false, article };
      } catch (err) {
        if (err instanceof ApiError && err.kind === 'conflict') {
          const { articleId, readerUrl } = err.body;
          return {
            alreadySaved: true,
            articleId: typeof articleId === 'string' ? articleId : null,
            readerUrl: typeof readerUrl === 'string' ? readerUrl : null,
          };
        }
        throw err;
      }
    },

    saveText(text, title) {
      const body: Record<string, unknown> = { text, source: 'api' };
      if (title !== undefined) body['title'] = title;
      return request<Article>('POST', '/api/articles/text', body, SAVE_TIMEOUT_MS);
    },

    search(params) {
      const q = new URLSearchParams({ limit: String(params.limit ?? PAGE_SIZE) });
      if (params.query !== undefined && params.query !== '') q.set('q', params.query);
      if (params.tagId !== undefined) q.set('tag', params.tagId);
      return request<Article[]>('GET', `/api/articles/search?${q.toString()}`);
    },

    async archive(id) {
      await request<unknown>('POST', `${at(id)}/archive`);
    },
    async unarchive(id) {
      await request<unknown>('POST', `${at(id)}/unarchive`);
    },

    highlights(params = {}) {
      const q = new URLSearchParams({ limit: String(params.limit ?? PAGE_SIZE) });
      if (params.offset !== undefined && params.offset > 0) q.set('offset', String(params.offset));
      return request<HighlightsPage>('GET', `/api/highlights?${q.toString()}`);
    },
    articleHighlights: (id) => request<Highlight[]>('GET', `${at(id)}/highlights`),

    tags: () => request<Tag[]>('GET', '/api/tags'),

    readerUrl: (id) => `${serverUrl}/app/read/${encodeURIComponent(id)}`,
  };
}

/** The cursor that continues a list after this article. */
export function cursorAfter(article: Article, archived: boolean): { at: string; id: string } | null {
  const at = archived ? article.archivedAt : article.savedAt;
  return at === null ? null : { at, id: article.id };
}

/**
 * Up to `limit` articles, walking as many pages as that takes. The cursor
 * (rather than an offset) is what keeps the walk honest when something is
 * archived halfway through it.
 */
export async function walkArticles(client: Client, params: ListParams, limit: number): Promise<Article[]> {
  const out: Article[] = [];
  let before = params.before;
  while (out.length < limit) {
    const want = Math.min(100, limit - out.length);
    const page = await client.articles({ ...params, limit: want, before });
    out.push(...page);
    if (page.length < want) break;
    const next = cursorAfter(page[page.length - 1]!, params.archived === true);
    if (next === null) break;
    before = next;
  }
  return out;
}
