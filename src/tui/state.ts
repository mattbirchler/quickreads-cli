// Everything the interactive browser knows, as plain data. The controller
// (app.ts) changes it and the renderer (render.ts) draws it; neither the
// terminal nor the network appears here.
import type { Article, Highlight } from '../types.ts';

export type Source =
  | { kind: 'queue' }
  | { kind: 'todo' }
  | { kind: 'archive' }
  | { kind: 'search'; query: string };

export const TABS = ['queue', 'todo', 'archive'] as const;
export type Tab = typeof TABS[number];

export const TAB_LABEL: Record<Tab, string> = { queue: 'Queue', todo: 'To Do', archive: 'Archive' };

export interface ListView {
  source: Source;
  items: Article[];
  // Index into items, or -1 while the list is empty.
  selected: number;
  // First visible line of the list body. Lines, not items: rows can be two
  // lines tall and date headings sit between them.
  scroll: number;
  loading: boolean;
  loadingMore: boolean;
  // True once a page came back short: there is nothing further to fetch.
  exhausted: boolean;
  error: string | null;
}

export interface ReaderView {
  // The list row at first, then the full article once it has loaded.
  article: Article;
  loading: boolean;
  error: string | null;
  highlights: Highlight[];
  // The article laid out at `width`. Rebuilt when the terminal is resized.
  lines: string[];
  width: number;
  scroll: number;
  // Where Esc goes back to.
  from: 'list' | 'highlights';
}

export interface HighlightsView {
  items: Highlight[];
  total: number;
  selected: number;
  // First visible body line (highlights are several lines tall each).
  scroll: number;
  loading: boolean;
  error: string | null;
}

export interface Prompt {
  kind: 'search' | 'save';
  value: string;
}

export type Tone = 'ok' | 'error' | 'busy' | 'info';

export interface Notice {
  text: string;
  tone: Tone;
}

// Roomy rows are two lines with an excerpt; compact rows are one.
export type View = 'roomy' | 'compact';

export interface State {
  screen: 'list' | 'reader' | 'highlights' | 'help';
  // The screen the help was opened over.
  behindHelp: 'list' | 'reader' | 'highlights';
  list: ListView;
  reader: ReaderView | null;
  highlights: HighlightsView | null;
  prompt: Prompt | null;
  // A transient sentence in the footer (archived, copied, could not save).
  notice: Notice | null;
  view: View;
  // Spinner frame, advanced only while something is loading.
  spin: number;
}

export function emptyList(source: Source): ListView {
  return { source, items: [], selected: -1, scroll: 0, loading: true, loadingMore: false, exhausted: false, error: null };
}

export function initialState(view: View = 'roomy'): State {
  return {
    view,
    screen: 'list',
    behindHelp: 'list',
    list: emptyList({ kind: 'queue' }),
    reader: null,
    highlights: null,
    prompt: null,
    notice: null,
    spin: 0,
  };
}

export function isBusy(state: State): boolean {
  return state.list.loading || state.list.loadingMore ||
    state.reader?.loading === true || state.highlights?.loading === true ||
    state.notice?.tone === 'busy';
}

/** Keep a selection inside [0, length), or -1 when there is nothing to select. */
export function clampSelection(selected: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(length - 1, Math.max(0, selected));
}

/** The scroll offset that keeps rows [from, to) visible in a window of `height`. */
export function scrollToShow(scroll: number, from: number, to: number, height: number): number {
  if (from < scroll) return Math.max(0, from);
  if (to > scroll + height) return Math.max(0, Math.min(from, to - height));
  return scroll;
}

export function clampScroll(scroll: number, total: number, height: number): number {
  return Math.max(0, Math.min(scroll, Math.max(0, total - height)));
}
