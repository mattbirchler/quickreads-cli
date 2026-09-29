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

/** How long ago it joined the list it is in: saved, or archived once it has been. */
export function ageOf(article: Pick<Article, 'savedAt' | 'archivedAt'>, now: Date): string {
  return compactTime(new Date(article.archivedAt ?? article.savedAt), now);
}

/** Reading time, or "link" for a save that has no text to read. */
export function lengthOf(article: Pick<Article, 'type' | 'wordCount'>): string {
  return article.type === 'link' ? 'link' : readingTime(article.wordCount);
}

/** How far through, from 0 to 1, or null when it is unread or finished. */
export function progressOf(article: Pick<Article, 'readProgress'>): number | null {
  const p = article.readProgress;
  return p !== undefined && p > 0 && p < 1 ? p : null;
}

/** The right-hand side of a one-line row: where it is from, how long, how far, how old. */
export function rowMeta(article: Article, now: Date): string {
  const progress = progressOf(article);
  return [
    siteOf(article),
    lengthOf(article),
    progress === null ? '' : `${Math.round(progress * 100)}%`,
    ageOf(article, now),
  ].filter((s) => s !== '').join(' · ');
}

export interface DayGroup {
  key: string;
  label: string;
}

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * The heading a date files under, by the reader's own calendar: Today and
 * Yesterday are days, not 24-hour windows, so something saved at 11pm is
 * "Yesterday" at 1am.
 */
export function dayGroup(date: Date, now: Date): DayGroup {
  if (Number.isNaN(date.getTime())) return { key: 'unknown', label: 'Undated' };
  // Rounded, because a day that contains a clock change is not 24 hours long.
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (days < 7) return { key: 'week', label: 'Past week' };
  if (days < 30) return { key: 'month', label: 'Past month' };
  const sameYear = date.getFullYear() === now.getFullYear();
  return {
    key: `${date.getFullYear()}-${date.getMonth()}`,
    label: date.toLocaleDateString('en-US', sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' }),
  };
}

/** What is left to read, as a sentence fragment, or '' when that is under a minute. */
export function timeLeft(wordCount: number, fraction: number): string {
  if (!Number.isFinite(wordCount) || wordCount <= 0) return '';
  const minutes = Math.round((wordCount * Math.max(0, 1 - fraction)) / WORDS_PER_MINUTE);
  return minutes < 1 ? '' : `${minutes} min left`;
}

/** "1 article", "3 articles": counts that agree with their noun. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
