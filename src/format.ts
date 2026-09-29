// The small sentences a row is made of: how old, how long, from where.
import type { Article } from './types.ts';

/** How long ago, in the fewest characters that still read as a time. */
export function compactTime(date: Date | null, now: Date): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  const mins = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  // Older than a week: a date is more useful than a growing day count. Same
  // calendar year drops the year, matching how you'd say it out loud.
  return shortDate(date, now);
}

export function shortDate(date: Date, now: Date): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function longDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// A comfortable silent-reading pace. The point is "coffee or lunch", not a
// stopwatch, so anything under a minute still says a minute.
const WORDS_PER_MINUTE = 238;

export function readingTime(wordCount: number): string {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return '';
  return `${Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE))} min`;
}

/** The hostname without its www, for articles that came with no site name. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function titleOf(article: Pick<Article, 'title' | 'url'>): string {
  return article.title?.trim() || hostOf(article.url) || '(untitled)';
}

export function siteOf(article: Pick<Article, 'siteName' | 'url' | 'hasOriginalUrl'>): string {
  const named = article.siteName?.trim();
  if (named) return named;
  return article.hasOriginalUrl === false ? '' : hostOf(article.url);
}

/** The right-hand side of a list row: where it is from, how long, how old. */
export function rowMeta(article: Article, now: Date): string {
  const archived = article.archivedAt !== null;
  const when = new Date(archived ? article.archivedAt! : article.savedAt);
  const progress = article.readProgress !== undefined && article.readProgress > 0 && article.readProgress < 1
    ? `${Math.round(article.readProgress * 100)}%`
    : '';
  const length = article.type === 'link' ? 'link' : readingTime(article.wordCount);
  return [siteOf(article), length, progress, compactTime(when, now)].filter((s) => s !== '').join(' · ');
}

/** "1 article", "3 articles": counts that agree with their noun. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
