// `quickreads read 3` has to know what row 3 was. Every listing writes the
// articles it printed, in order, to a small file; the next command that is
// handed a number looks it up there.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Ref {
  id: string;
  // Kept so `archive 3` can say what it archived without a round trip.
  title: string;
}

export interface RefStore {
  load(): Ref[] | null;
  save(refs: Ref[]): void;
}

export function cacheDir(): string {
  if (process.env['QUICKREADS_HOME']) return process.env['QUICKREADS_HOME'];
  const xdg = process.env['XDG_CACHE_HOME'];
  return join(xdg && xdg !== '' ? xdg : join(homedir(), '.cache'), 'quickreads');
}

const refsPath = (): string => join(cacheDir(), 'last-listing.json');

export const fileRefs: RefStore = {
  load() {
    try {
      const parsed: unknown = JSON.parse(readFileSync(refsPath(), 'utf8'));
      if (!Array.isArray(parsed)) return null;
      return parsed.filter((r): r is Ref =>
        r !== null && typeof r === 'object' && typeof (r as Ref).id === 'string' && typeof (r as Ref).title === 'string');
    } catch {
      return null;
    }
  },
  save(refs) {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      // Titles are the reader's own reading list; nobody else needs to see it.
      writeFileSync(refsPath(), JSON.stringify(refs), { mode: 0o600 });
    } catch {
      // A read-only home directory costs the numbered shortcuts, not the listing.
    }
  },
};

export type Resolved = { ok: true; ref: Ref } | { ok: false; error: string };

/**
 * What a person typed for <article>, to an article id: a row number from the
 * last listing, a link to the article in Quick Reads, or the id itself.
 */
export function resolveRef(input: string, refs: Ref[] | null): Resolved {
  const typed = input.trim();
  if (typed === '') return { ok: false, error: 'Which article? Pass a row number or an article id.' };

  // Ids are UUIDs, so a short run of digits can only be a row number.
  if (/^\d{1,4}$/.test(typed)) {
    const n = Number(typed);
    if (refs === null || refs.length === 0) {
      return { ok: false, error: `There is no listing for ${n} to refer to. Run \`quickreads list\` first.` };
    }
    const ref = refs[n - 1];
    if (n < 1 || ref === undefined) {
      return { ok: false, error: `The last listing had ${refs.length === 1 ? 'one row' : `${refs.length} rows`}; there is no ${n}.` };
    }
    return { ok: true, ref };
  }

  const fromLink = /\/app\/read\/([^/?#\s]+)/.exec(typed);
  const id = fromLink === null ? typed : decodeURIComponent(fromLink[1]!);
  const known = refs?.find((r) => r.id === id);
  return { ok: true, ref: known ?? { id, title: '' } };
}
