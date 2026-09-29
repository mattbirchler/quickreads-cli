// The one place HTTP happens. Callers get JSON or an ApiError whose `kind`
// they can switch on; nobody else parses status codes. Every endpoint here is
// one the public docs describe (https://quickreads.app/docs).
import type { Account } from './types.ts';

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

export { READ_TIMEOUT_MS, SAVE_TIMEOUT_MS };

// What `quickreads auth` calls to prove a pasted key works. /api/me answers
// even for an account with no subscription, so a lapsed user still gets a
// truthful "connected" plus their tier.
export async function verifyToken(serverUrl: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Account> {
  return createRequester(serverUrl, token, fetchImpl)<Account>('GET', '/api/me');
}
