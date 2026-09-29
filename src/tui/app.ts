// The interactive browser's controller: keys in, state changes and API calls
// out, a repaint after each. It talks to a Terminal interface rather than to
// process.stdout, so the tests drive it key by key against a fake account and
// read the frames it paints.
import { ApiError, PAGE_SIZE, cursorAfter, loadForReading, type Client } from '../api.ts';
import type { Article, Highlight } from '../types.ts';
import { progressOf, titleOf } from '../format.ts';
import { articleHeader, lineOfHighlight, renderArticle } from '../layout.ts';
import { destinationOf, normalizeUrl } from '../commands.ts';
import { isPrintable, parseKeys } from './keys.ts';
import { bodyHeight, highlightsBody, listBody, readingColumn, renderFrame, rowHeight } from './render.ts';
import {
  TABS, clampScroll, clampSelection, emptyList, initialState, isBusy, scrollToShow,
  type Source, type State, type Tab, type Tone, type View,
} from './state.ts';

export interface Terminal {
  cols(): number;
  rows(): number;
  paint(frame: string[]): void;
  open(url: string): void;
  /** True when the clipboard confirmed it. */
  copy(text: string): boolean;
  quit(code: number): void;
  now(): Date;
  /** Keep a preference for next time. */
  remember?(view: View): void;
}

export interface AppOptions {
  view?: View;
}

export interface App {
  readonly state: State;
  start(): void;
  /** A chunk of raw input from the terminal. */
  input(chunk: string): void;
  resize(): void;
  /** The frame as it would be painted right now. */
  frame(): string[];
  /** Resolves once nothing is in flight. */
  settled(): Promise<void>;
  /** Stop every timer. The app paints nothing after this. */
  stop(): void;
}

// How long a footer notice stays before the hints return.
const NOTICE_MS = 4_000;
const SPIN_MS = 120;
// Fetch the next page while there is still this much list left to arrow through.
const LOAD_AHEAD = 10;
const HIGHLIGHTS_PAGE = 50;

interface Undo {
  article: Article;
  index: number;
  tab: Source['kind'];
  // What the article was changed to; undoing sets it back.
  archived: boolean;
}

function say(err: unknown): string {
  if (err instanceof ApiError && err.kind === 'unauthorized') {
    return 'The server rejected this API key. Quit and run `quickreads auth` to connect again.';
  }
  return err instanceof Error ? err.message : String(err);
}

export function createApp(client: Client, term: Terminal, options: AppOptions = {}): App {
  const state = initialState(options.view);
  const inFlight = new Set<Promise<unknown>>();
  let stopped = false;
  let spinTimer: NodeJS.Timeout | null = null;
  let noticeTimer: NodeJS.Timeout | null = null;
  // Each load takes a ticket; an answer whose ticket has been superseded (the
  // reader moved on before it arrived) is dropped instead of painted.
  let listTicket = 0;
  let readerTicket = 0;
  let highlightsTicket = 0;
  let undo: Undo | null = null;
  // The tab a search was started from, which is where Esc returns to.
  let tabBehindSearch: Tab = 'queue';
  // The highlight the reader was opened for, to scroll to once it has loaded.
  let seeking: string | null = null;
  // True from opening an article until its text has been laid out once.
  let resuming = false;

  const height = (): number => bodyHeight(term.rows());

  function paint(): void {
    if (stopped) return;
    term.paint(renderFrame(state, term.now(), term.cols(), term.rows()));
    // The spinner exists only while something is genuinely in motion.
    const busy = isBusy(state);
    if (busy && spinTimer === null) {
      spinTimer = setInterval(() => { state.spin += 1; paint(); }, SPIN_MS);
      spinTimer.unref();
    } else if (!busy && spinTimer !== null) {
      clearInterval(spinTimer);
      spinTimer = null;
    }
  }

  function notice(text: string, tone: Tone = 'info'): void {
    state.notice = { text, tone };
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    // Work in progress stays up until whatever replaces it; everything else
    // has said its piece after a few seconds.
    if (tone !== 'busy') {
      noticeTimer = setTimeout(() => { state.notice = null; paint(); }, NOTICE_MS);
      noticeTimer.unref();
    }
    paint();
  }

  function track<T>(work: Promise<T>): void {
    const tracked = work.catch(() => undefined).finally(() => { inFlight.delete(tracked); });
    inFlight.add(tracked);
  }

  // ── Lists ────────────────────────────────────────────────────────────────

  const listParams = (source: Source) => ({
    archived: source.kind === 'archive',
    ...(source.kind === 'todo' ? { list: 'todo' as const } : {}),
  });

  function showSelection(): void {
    const { list } = state;
    if (list.selected < 0) { list.scroll = 0; return; }
    const { lines, blocks } = listBody(list, state.view, term.now(), term.cols());
    const block = blocks[list.selected];
    if (block === undefined) return;
    // A row's date heading comes into view with it, so the first row of a
    // day is never shown without saying which day.
    list.scroll = clampScroll(
      scrollToShow(list.scroll, block.start - block.lead, block.start + block.height, height()),
      lines.length,
      height(),
    );
  }

  // Nearly a screenful of rows, with one of overlap to keep the reader oriented.
  const listPage = (): number => Math.max(1, Math.floor(height() / rowHeight(state.view)) - 1);

  function loadList(source: Source, keep = false): void {
    const ticket = ++listTicket;
    const keptId = keep ? state.list.items[state.list.selected]?.id : undefined;
    // A refresh keeps the rows on screen until the new ones arrive; a
    // different list starts empty.
    state.list = keep
      ? { ...state.list, loading: true, error: null }
      : emptyList(source);
    paint();

    track((async () => {
      try {
        const items = source.kind === 'search'
          ? await client.search({ query: source.query, limit: PAGE_SIZE })
          : await client.articles({ ...listParams(source), limit: PAGE_SIZE });
        if (ticket !== listTicket) return;
        const at = keptId === undefined ? -1 : items.findIndex((a) => a.id === keptId);
        state.list = {
          source,
          items,
          selected: clampSelection(at >= 0 ? at : keep ? state.list.selected : 0, items.length),
          scroll: keep ? state.list.scroll : 0,
          loading: false,
          loadingMore: false,
          exhausted: source.kind === 'search' || items.length < PAGE_SIZE,
          error: null,
        };
        showSelection();
      } catch (err) {
        if (ticket !== listTicket) return;
        const hidden = err instanceof ApiError && err.kind === 'forbidden' && source.kind === 'todo';
        state.list = {
          ...emptyList(source),
          loading: false,
          error: hidden ? 'To Do is hidden on this account. Turn it back on in Quick Reads to use it here.' : say(err),
        };
      }
      paint();
    })());
  }

  function loadMore(): void {
    const { list } = state;
    if (list.loading || list.loadingMore || list.exhausted || list.source.kind === 'search') return;
    const last = list.items[list.items.length - 1];
    const before = last === undefined ? null : cursorAfter(last, list.source.kind === 'archive');
    if (before === null) { list.exhausted = true; return; }

    const ticket = listTicket;
    list.loadingMore = true;
    track((async () => {
      try {
        const page = await client.articles({ ...listParams(list.source), limit: PAGE_SIZE, before });
        if (ticket !== listTicket) return;
        const known = new Set(state.list.items.map((a) => a.id));
        state.list.items.push(...page.filter((a) => !known.has(a.id)));
        state.list.exhausted = page.length < PAGE_SIZE;
      } catch (err) {
        if (ticket !== listTicket) return;
        // The rows already on screen are still good; say what happened and
        // let the next arrow key try again.
        notice(say(err), 'error');
      } finally {
        if (ticket === listTicket) state.list.loadingMore = false;
      }
      paint();
    })());
  }

  function moveSelection(delta: number): void {
    const { list } = state;
    if (list.items.length === 0) return;
    list.selected = clampSelection(list.selected + delta, list.items.length);
    showSelection();
    if (list.selected >= list.items.length - LOAD_AHEAD) loadMore();
    paint();
  }

  function switchTab(tab: Tab): void {
    if (state.list.source.kind === tab && state.list.error === null) return;
    loadList({ kind: tab });
  }

  function cycleTab(step: 1 | -1): void {
    const current = state.list.source.kind === 'search' ? tabBehindSearch : state.list.source.kind;
    const at = TABS.indexOf(current);
    switchTab(TABS[(at + step + TABS.length) % TABS.length]!);
  }

  const selectedArticle = (): Article | undefined =>
    (state.list.selected >= 0 ? state.list.items[state.list.selected] : undefined);

  // ── Reader ───────────────────────────────────────────────────────────────

  function layoutReader(): void {
    const reader = state.reader;
    if (reader === null) return;
    const { width } = readingColumn(term.cols());
    const total = Math.max(1, reader.lines.length);
    const progress = reader.scroll / total;
    reader.width = width;
    if (reader.loading) {
      reader.lines = articleHeader(reader.article, width, false);
      reader.scroll = 0;
      return;
    }
    const rendered = renderArticle(reader.article, {
      width,
      highlights: reader.highlights,
      showUrl: false,
      hyperlinks: true,
      emptyHint: 'Press o to open it in your browser.',
    });
    reader.lines = rendered.lines;
    const overflow = Math.max(0, reader.lines.length - height());
    if (seeking !== null) {
      // Open at the passage that was picked, with a little of what leads
      // into it.
      const line = lineOfHighlight(rendered.marks, seeking);
      reader.scroll = line === null ? 0 : line - 3;
      seeking = null;
      resuming = false;
    } else if (resuming) {
      // Pick up where Quick Reads says the reading stopped, on any device.
      resuming = false;
      const left = progressOf(reader.article);
      if (left !== null && overflow > 0) {
        reader.scroll = Math.round(left * overflow);
        if (reader.scroll > 0) notice(`Picked up at ${Math.round(left * 100)}%. Press g for the top.`);
      }
    } else {
      reader.scroll = Math.round(progress * reader.lines.length);
    }
    reader.scroll = clampScroll(reader.scroll, reader.lines.length, height());
  }

  function openReader(article: Article, from: 'list' | 'highlights', highlight: string | null = null): void {
    const ticket = ++readerTicket;
    seeking = highlight;
    resuming = true;
    state.reader = {
      article, loading: true, error: null, highlights: [], lines: [], width: 0, scroll: 0, from,
    };
    state.screen = 'reader';
    layoutReader();
    paint();

    track((async () => {
      try {
        const { article: full, highlights } = await loadForReading(client, article.id);
        if (ticket !== readerTicket || state.reader === null) return;
        state.reader.article = full;
        state.reader.highlights = highlights;
        state.reader.loading = false;
        layoutReader();
      } catch (err) {
        if (ticket !== readerTicket || state.reader === null) return;
        state.reader.loading = false;
        state.reader.error = say(err);
      }
      paint();
    })());
  }

  function closeReader(): void {
    if (state.reader === null) return;
    readerTicket += 1;
    state.screen = state.reader.from;
    state.reader = null;
    seeking = null;
    paint();
  }

  function scrollReader(delta: number): void {
    const reader = state.reader;
    if (reader === null) return;
    reader.scroll = clampScroll(reader.scroll + delta, reader.lines.length, height());
    paint();
  }

  // Nearly a screen, with one line of overlap to keep the reader oriented.
  const pageSize = (): number => Math.max(1, height() - 1);

  // ── Archiving ────────────────────────────────────────────────────────────

  function setArchived(article: Article, archived: boolean, quiet = false): void {
    const { list } = state;
    const tab = list.source.kind;
    const index = list.items.findIndex((a) => a.id === article.id);
    const before = { ...article };
    const stamp = archived ? term.now().toISOString() : null;

    // Say it happened now; take it back if the server disagrees.
    if (index >= 0) {
      if (tab === 'search') list.items[index] = { ...list.items[index]!, archivedAt: stamp };
      else {
        list.items.splice(index, 1);
        list.selected = clampSelection(list.selected > index ? list.selected - 1 : list.selected, list.items.length);
        showSelection();
        if (list.items.length < height() + LOAD_AHEAD) loadMore();
      }
    }
    if (!quiet) {
      undo = { article: before, index: Math.max(0, index), tab, archived };
      const what = !archived ? 'Back in the queue' : before.list === 'todo' ? 'Done' : 'Archived';
      notice(`${what}: ${titleOf(before)}. Press u to undo.`, 'ok');
    }

    const ticket = listTicket;
    track((async () => {
      try {
        if (archived) await client.archive(article.id);
        else await client.unarchive(article.id);
      } catch (err) {
        if (!quiet) undo = null;
        if (ticket === listTicket && index >= 0) restore(before, index, tab);
        notice(`Could not ${archived ? 'archive' : 'unarchive'} that: ${say(err)}`, 'error');
      }
    })());
  }

  /** Put an article back in the list it was taken from, if that list is still up. */
  function restore(article: Article, index: number, tab: Source['kind']): void {
    const { list } = state;
    if (list.source.kind !== tab) return;
    const at = list.items.findIndex((a) => a.id === article.id);
    if (at >= 0) list.items[at] = article;
    else {
      const where = Math.min(index, list.items.length);
      list.items.splice(where, 0, article);
      list.selected = where;
    }
    list.selected = clampSelection(list.selected, list.items.length);
    showSelection();
  }

  function toggleArchive(article: Article | undefined): void {
    if (article === undefined) return;
    setArchived(article, article.archivedAt === null);
  }

  function undoLast(): void {
    if (undo === null) return notice('Nothing to undo.');
    const { article, index, tab, archived } = undo;
    undo = null;
    const ticket = listTicket;
    track((async () => {
      try {
        if (archived) await client.unarchive(article.id);
        else await client.archive(article.id);
        if (ticket === listTicket) restore(article, index, tab);
        notice(`Undone: ${titleOf(article)}.`, 'ok');
      } catch (err) {
        notice(`Could not undo that: ${say(err)}`, 'error');
      }
    })());
  }

  // ── Highlights ───────────────────────────────────────────────────────────

  function showHighlight(): void {
    const view = state.highlights;
    if (view === null || view.selected < 0) return;
    const { lines, blocks } = highlightsBody(view, term.now(), term.cols());
    const block = blocks[view.selected];
    if (block === undefined) return;
    view.scroll = clampScroll(
      scrollToShow(view.scroll, block.start, block.start + block.height, height()),
      lines.length,
      height(),
    );
    // The first block rides with the top of the screen.
    if (view.selected === 0) view.scroll = 0;
  }

  function loadHighlights(more = false): void {
    const ticket = more ? highlightsTicket : ++highlightsTicket;
    if (!more || state.highlights === null) {
      state.highlights = { items: [], total: 0, selected: -1, scroll: 0, loading: true, error: null };
    } else {
      state.highlights.loading = true;
    }
    const offset = more ? state.highlights.items.length : 0;
    paint();

    track((async () => {
      try {
        const page = await client.highlights({ limit: HIGHLIGHTS_PAGE, offset });
        if (ticket !== highlightsTicket || state.highlights === null) return;
        const view = state.highlights;
        const known = new Set(view.items.map((h) => h.id));
        view.items.push(...page.highlights.filter((h) => !known.has(h.id)));
        // A short page means the end, whatever the total claimed.
        view.total = page.highlights.length < HIGHLIGHTS_PAGE ? view.items.length : Math.max(page.total, view.items.length);
        view.selected = clampSelection(view.selected < 0 ? 0 : view.selected, view.items.length);
        view.loading = false;
        showHighlight();
      } catch (err) {
        if (ticket !== highlightsTicket || state.highlights === null) return;
        state.highlights.loading = false;
        if (more) notice(say(err), 'error');
        else state.highlights.error = say(err);
      }
      paint();
    })());
  }

  function moveHighlight(delta: number): void {
    const view = state.highlights;
    if (view === null || view.items.length === 0) return;
    view.selected = clampSelection(view.selected + delta, view.items.length);
    showHighlight();
    if (!view.loading && view.items.length < view.total && view.selected >= view.items.length - LOAD_AHEAD) {
      loadHighlights(true);
      return;
    }
    paint();
  }

  const selectedHighlight = (): Highlight | undefined => {
    const view = state.highlights;
    return view === null || view.selected < 0 ? undefined : view.items[view.selected];
  };

  /** Enough of an article to open the reader on, from what a highlight knows. */
  const articleBehind = (h: Highlight): Article => ({
    id: h.articleId,
    url: h.url ?? '',
    hasOriginalUrl: h.url !== undefined && h.url !== null && h.url !== '',
    title: h.articleTitle ?? null,
    author: h.author ?? null,
    siteName: h.siteName ?? null,
    excerpt: null,
    wordCount: 0,
    type: 'article',
    publishedAt: null,
    savedAt: h.createdAt,
    archivedAt: null,
  });

  // ── Open, copy, save, search ─────────────────────────────────────────────

  function openInBrowser(article: Article | undefined): void {
    if (article === undefined) return;
    term.open(destinationOf(article, client));
    notice('Opened in your browser.');
  }

  function copy(text: string, what: string): void {
    // The terminal has been asked either way; only a confirming clipboard
    // lets us claim success out loud.
    if (term.copy(text)) notice(`${what} copied.`, 'ok');
    else notice(`${what} sent to the terminal clipboard.`);
  }

  function copyLink(article: Article | undefined): void {
    if (article === undefined) return;
    copy(destinationOf(article, client), 'Link');
  }

  function submitSave(value: string): void {
    const url = normalizeUrl(value);
    if (url === null) {
      return notice(`${value.trim() === '' ? 'That' : value.trim()} does not look like a web address.`, 'error');
    }
    const tab = state.list.source.kind;
    notice(`Saving ${url}`, 'busy');
    track((async () => {
      try {
        const result = await client.save(url, tab === 'todo' ? { list: 'todo' } : {});
        if (result.alreadySaved) return notice('Already saved.');
        const { article } = result;
        const home: Tab = article.list === 'todo' ? 'todo' : 'queue';
        if (state.list.source.kind === home && !state.list.items.some((a) => a.id === article.id)) {
          const { content: _, ...row } = article;
          state.list.items.unshift(row);
          state.list.selected = state.list.selected < 0 ? 0 : state.list.selected + 1;
          if (state.list.scroll > 0) state.list.scroll += rowHeight(state.view);
          showSelection();
        }
        const blocked = article.fetchBlocked === true ? ' The site refused the page, so only the link was kept.' : '';
        notice(`Saved to ${home === 'todo' ? 'To Do' : 'your queue'}: ${titleOf(article)}.${blocked}`, 'ok');
      } catch (err) {
        notice(`Could not save that: ${say(err)}`, 'error');
      }
    })());
  }

  function submitSearch(value: string): void {
    const query = value.trim();
    if (query === '') return paint();
    if (state.list.source.kind !== 'search') tabBehindSearch = state.list.source.kind;
    state.screen = 'list';
    state.reader = null;
    loadList({ kind: 'search', query });
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  function promptKey(key: string): void {
    const prompt = state.prompt;
    if (prompt === null) return;
    if (key === 'esc') state.prompt = null;
    else if (key === 'enter') {
      state.prompt = null;
      if (prompt.kind === 'search') return submitSearch(prompt.value);
      return submitSave(prompt.value);
    } else if (key === 'backspace') prompt.value = [...prompt.value].slice(0, -1).join('');
    else if (key === 'ctrl-u') prompt.value = '';
    else if (key === 'ctrl-w') prompt.value = prompt.value.replace(/\S+\s*$/, '');
    else if (isPrintable(key)) prompt.value += key;
    paint();
  }

  function ask(kind: 'search' | 'save'): void {
    state.notice = null;
    state.prompt = { kind, value: '' };
    paint();
  }

  function toggleView(): void {
    state.view = state.view === 'roomy' ? 'compact' : 'roomy';
    term.remember?.(state.view);
    showSelection();
    notice(state.view === 'roomy' ? 'Roomy rows.' : 'Compact rows.');
  }

  function showHelp(): void {
    if (state.screen === 'help') return;
    state.behindHelp = state.screen;
    state.screen = 'help';
    paint();
  }

  function listKey(key: string): void {
    switch (key) {
      case 'up': case 'k': return moveSelection(-1);
      case 'down': case 'j': return moveSelection(1);
      case 'pagedown': case ' ': return moveSelection(listPage());
      case 'pageup': case 'b': return moveSelection(-listPage());
      case 'home': case 'g': return moveSelection(-state.list.items.length);
      case 'end': case 'G': return moveSelection(state.list.items.length);
      case 'enter': case 'right': case 'l': {
        const article = selectedArticle();
        if (article !== undefined) openReader(article, 'list');
        return;
      }
      case 'a': return toggleArchive(selectedArticle());
      case 'u': return undoLast();
      case 'o': return openInBrowser(selectedArticle());
      case 'c': return copyLink(selectedArticle());
      case 's': return ask('save');
      case '/': return ask('search');
      case 'h': state.screen = 'highlights'; return loadHighlights();
      case 'r': return loadList(state.list.source, true);
      case 'v': return toggleView();
      case 'tab': return cycleTab(1);
      case 'shift-tab': return cycleTab(-1);
      case '1': return switchTab('queue');
      case '2': return switchTab('todo');
      case '3': return switchTab('archive');
      case '?': return showHelp();
      case 'esc':
        if (state.list.source.kind === 'search') return loadList({ kind: tabBehindSearch });
        return term.quit(0);
      case 'q': return term.quit(0);
      default:
    }
  }

  function readerKey(key: string): void {
    const reader = state.reader;
    if (reader === null) return;
    switch (key) {
      case 'up': case 'k': return scrollReader(-1);
      case 'down': case 'j': case 'enter': return scrollReader(1);
      case 'pagedown': case ' ': case 'f': return scrollReader(pageSize());
      case 'pageup': case 'b': return scrollReader(-pageSize());
      case 'home': case 'g': return scrollReader(-reader.lines.length);
      case 'end': case 'G': return scrollReader(reader.lines.length);
      case 'a': {
        const { article } = reader;
        closeReader();
        return toggleArchive(article);
      }
      case 'u': return undoLast();
      case 'o': return openInBrowser(reader.article);
      case 'c': return copyLink(reader.article);
      case '/': return ask('search');
      case '?': return showHelp();
      case 'esc': case 'q': case 'left': case 'h': return closeReader();
      default:
    }
  }

  function highlightsKey(key: string): void {
    switch (key) {
      case 'up': case 'k': return moveHighlight(-1);
      case 'down': case 'j': return moveHighlight(1);
      case 'pagedown': case ' ': return moveHighlight(5);
      case 'pageup': case 'b': return moveHighlight(-5);
      case 'home': case 'g': return moveHighlight(-(state.highlights?.items.length ?? 0));
      case 'end': case 'G': return moveHighlight(state.highlights?.items.length ?? 0);
      case 'enter': case 'right': case 'l': {
        const h = selectedHighlight();
        if (h !== undefined) openReader(articleBehind(h), 'highlights', h.text);
        return;
      }
      case 'c': {
        const h = selectedHighlight();
        if (h !== undefined) copy(h.text, 'Highlight');
        return;
      }
      case 'o': {
        const h = selectedHighlight();
        if (h !== undefined) openInBrowser(articleBehind(h));
        return;
      }
      case 'r': return loadHighlights();
      case '/': return ask('search');
      case '?': return showHelp();
      case 'esc': case 'q': case 'left': case 'h':
        highlightsTicket += 1;
        state.highlights = null;
        state.screen = 'list';
        return paint();
      default:
    }
  }

  function handle(key: string): void {
    // Ctrl-C leaves from anywhere, a prompt included.
    if (key === 'ctrl-c') return term.quit(0);
    if (state.prompt !== null) return promptKey(key);
    if (state.screen === 'help') {
      state.screen = state.behindHelp;
      return paint();
    }
    if (state.screen === 'reader') return readerKey(key);
    if (state.screen === 'highlights') return highlightsKey(key);
    return listKey(key);
  }

  return {
    state,
    start() {
      loadList({ kind: 'queue' });
    },
    input(chunk) {
      for (const key of parseKeys(chunk)) {
        if (stopped) return;
        handle(key);
      }
    },
    resize() {
      layoutReader();
      showSelection();
      showHighlight();
      paint();
    },
    frame: () => renderFrame(state, term.now(), term.cols(), term.rows()),
    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    stop() {
      stopped = true;
      if (spinTimer !== null) clearInterval(spinTimer);
      if (noticeTimer !== null) clearTimeout(noticeTimer);
      spinTimer = null;
      noticeTimer = null;
    },
  };
}
