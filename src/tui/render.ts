// Painting only. State in, lines out, so the tests can assert a whole frame
// without a terminal. Every frame is exactly `rows` lines tall and no line is
// wider than `cols`.
import type { Article, Highlight } from '../types.ts';
import { accent, bold, err, ink2, ink3, padEnd, reverse, stringWidth, truncate, useColor, warn } from '../ansi.ts';
import { compactTime, count, rowMeta, titleOf } from '../format.ts';
import { wrapText, MAX_READING_WIDTH } from '../layout.ts';
import { TABS, TAB_LABEL, type HighlightsView, type ListView, type ReaderView, type State } from './state.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Header, a blank line under it, and the footer.
export const CHROME_ROWS = 3;
export const bodyHeight = (rows: number): number => Math.max(1, rows - CHROME_ROWS);

/** The reading column: how wide, and how far in from the left edge. */
export function readingColumn(cols: number): { width: number; margin: number } {
  const width = Math.max(20, Math.min(MAX_READING_WIDTH, cols - 4));
  return { width, margin: Math.max(0, Math.floor((cols - width) / 2)) };
}

function header(leftPlain: string, left: string, rightPlain: string, right: string, cols: number): string {
  const gap = cols - stringWidth(leftPlain) - stringWidth(rightPlain);
  if (gap >= 2) return `${left}${' '.repeat(gap)}${right}`;
  // Too narrow for both: where you are matters more than the count.
  return truncate(leftPlain, cols);
}

function listHeader(state: State, cols: number): string {
  const { list } = state;
  const spinner = SPINNER[state.spin % SPINNER.length]!;

  let tabsPlain: string;
  let tabs: string;
  if (list.source.kind === 'search') {
    tabsPlain = `Search: ${list.source.query}`;
    tabs = `${ink3('Search: ')}${bold(list.source.query)}`;
  } else {
    const current = list.source.kind;
    // Weight marks the current list; without styling, brackets have to.
    const label = (tab: typeof TABS[number]): string =>
      tab === current && !useColor() ? `[${TAB_LABEL[tab]}]` : TAB_LABEL[tab];
    tabsPlain = TABS.map(label).join('  ');
    tabs = TABS.map((tab) => (tab === current ? bold(label(tab)) : ink3(label(tab)))).join('  ');
  }

  let rightPlain: string;
  let right: string;
  if (list.loading) {
    rightPlain = `${spinner} Loading `;
    right = `${warn(spinner)} ${ink3('Loading')} `;
  } else if (list.error !== null) {
    rightPlain = '';
    right = '';
  } else {
    const noun = list.source.kind === 'search' ? 'match' : list.source.kind === 'todo' ? 'item' : 'article';
    const n = list.items.length;
    const text = list.exhausted || list.source.kind === 'search'
      ? count(n, noun, noun === 'match' ? 'matches' : `${noun}s`)
      : `${n}+ ${noun}s`;
    const more = list.loadingMore ? `${spinner} ` : '';
    rightPlain = `${more}${text} `;
    right = `${more === '' ? '' : warn(more)}${ink3(text)} `;
  }

  return header(` Quick Reads  ${tabsPlain}`, `${bold(accent(' Quick Reads'))}  ${tabs}`, rightPlain, right, cols);
}

export function listRow(article: Article, selected: boolean, now: Date, cols: number, flagArchived: boolean): string {
  const title = titleOf(article);
  const state = flagArchived && article.archivedAt !== null ? 'archived · ' : '';
  const meta = state + rowMeta(article, now);
  const inner = cols - 4;
  const gap = inner - stringWidth(title) - stringWidth(meta);

  let titleCut = title;
  let metaShown = meta;
  let spaces = gap;
  if (gap < 2) {
    const titleRoom = inner - stringWidth(meta) - 2;
    if (titleRoom >= 20) {
      titleCut = truncate(title, titleRoom);
      spaces = inner - stringWidth(titleCut) - stringWidth(meta);
    } else {
      metaShown = '';
      titleCut = truncate(title, inner);
      spaces = inner - stringWidth(titleCut);
    }
  }
  if (selected) return reverse(padEnd(`  ${titleCut}${' '.repeat(Math.max(0, spaces))}${metaShown}  `, cols));
  return `  ${bold(titleCut)}${' '.repeat(Math.max(0, spaces))}${ink3(metaShown)}  `;
}

function emptyLead(list: ListView): string {
  switch (list.source.kind) {
    case 'queue': return 'Your queue is empty. Press s to save a link.';
    case 'todo': return 'Nothing to do. Press s to add a link.';
    case 'archive': return 'Nothing archived yet.';
    case 'search': return `Nothing matches "${list.source.query}". Press / to search again.`;
  }
}

function listBody(state: State, now: Date, cols: number, height: number): string[] {
  const { list } = state;
  if (list.error !== null) {
    return [...wrapText(list.error, cols - 4).map((l) => `  ${err(l)}`), `  ${ink3('Press r to try again.')}`];
  }
  if (list.items.length === 0) return list.loading ? [] : [`  ${ink3(emptyLead(list))}`];
  const flagArchived = list.source.kind === 'search';
  return list.items
    .slice(list.scroll, list.scroll + height)
    .map((a, i) => listRow(a, list.scroll + i === list.selected, now, cols, flagArchived));
}

/**
 * As many hints as fit, in order of usefulness. The last two are pinned: how
 * to see every key and how to leave are the ones a person stuck on a narrow
 * terminal needs most, so they are never the ones cut.
 */
export function fitHints(hints: string[], pinned: string[], cols: number): string {
  const room = cols - 1;
  const join = (parts: string[]): string => parts.join(' · ');
  const shown = [...hints];
  while (shown.length > 0 && stringWidth(join([...shown, ...pinned])) > room) shown.pop();
  const kept = [...pinned];
  while (kept.length > 1 && stringWidth(join([...shown, ...kept])) > room) kept.shift();
  return truncate(join([...shown, ...kept]), room);
}

function listHints(list: ListView): { hints: string[]; pinned: string[] } {
  const archive = list.source.kind === 'archive' ? 'a unarchive' : list.source.kind === 'todo' ? 'a done' : 'a archive';
  return {
    hints: ['↑/↓ move', '↵ read', archive, '/ search', 's save', 'h highlights', 'tab lists'],
    pinned: ['? keys', list.source.kind === 'search' ? 'esc back' : 'q quit'],
  };
}

function readerFrame(state: State, reader: ReaderView, cols: number, rows: number): string[] {
  const height = bodyHeight(rows);
  const { margin } = readingColumn(cols);
  const spinner = SPINNER[state.spin % SPINNER.length]!;

  const total = reader.lines.length;
  const position = reader.loading
    ? `${spinner} Loading `
    : total <= height ? '' : `${Math.round(((reader.scroll + height) / total) * 100)}% `;
  const crumbPlain = ' Quick Reads  ';
  const titleRoom = cols - stringWidth(crumbPlain) - stringWidth(position) - 2;
  const title = truncate(titleOf(reader.article), Math.max(0, titleRoom));
  const frame = [header(
    `${crumbPlain}${title}`,
    `${bold(accent(' Quick Reads'))}  ${ink2(title)}`,
    position,
    reader.loading ? `${warn(spinner)} ${ink3('Loading')} ` : ink3(position),
    cols,
  ), ''];

  const pad = ' '.repeat(margin);
  if (reader.error !== null) {
    frame.push(...wrapText(reader.error, cols - 4).map((l) => `  ${err(l)}`));
  } else {
    for (const line of reader.lines.slice(reader.scroll, reader.scroll + height)) {
      frame.push(line === '' ? '' : pad + line);
    }
  }
  return frame;
}

const READER_HINTS = { hints: ['↑/↓ scroll', 'space/b page', 'a archive', 'o open', 'c copy link'], pinned: ['? keys', 'esc back'] };

export interface HighlightBlock {
  // Body line the block starts on, and how many lines it takes.
  start: number;
  height: number;
}

/** The highlights screen body, with where each highlight landed in it. */
export function highlightsBody(view: HighlightsView, now: Date, cols: number): { lines: string[]; blocks: HighlightBlock[] } {
  const lines: string[] = [];
  const blocks: HighlightBlock[] = [];
  const width = Math.min(cols - 6, MAX_READING_WIDTH);
  view.items.forEach((h, i) => {
    if (i > 0) lines.push('');
    const start = lines.length;
    const selected = i === view.selected;
    lines.push(...highlightBlock(h, selected, now, width, cols));
    blocks.push({ start, height: lines.length - start });
  });
  return { lines, blocks };
}

function highlightBlock(h: Highlight, selected: boolean, now: Date, width: number, cols: number): string[] {
  const from = [h.articleTitle?.trim() || '(untitled)', h.siteName?.trim() ?? '', compactTime(new Date(h.createdAt), now)]
    .filter((s) => s !== '').join(' · ');
  const head = truncate(from, cols - 6);
  const pointer = selected ? accent('▸') : ' ';
  const bar = selected ? accent('▎') : ink3('▎');
  const out = [` ${pointer} ${selected ? bold(head) : ink3(head)}`];
  for (const l of wrapText(h.text, width)) out.push(`   ${bar} ${l}`);
  const note = h.note?.trim() ?? '';
  if (note !== '') {
    wrapText(note, width - 6).forEach((l, i) => out.push(`     ${ink2(i === 0 ? `Note: ${l}` : `      ${l}`)}`));
  }
  return out;
}

function highlightsFrame(state: State, view: HighlightsView, now: Date, cols: number, rows: number): string[] {
  const height = bodyHeight(rows);
  const spinner = SPINNER[state.spin % SPINNER.length]!;
  const rightPlain = view.loading
    ? `${spinner} Loading `
    : view.total > view.items.length ? `${view.items.length} of ${view.total} ` : `${count(view.items.length, 'highlight')} `;
  const frame = [header(
    ' Quick Reads  Highlights',
    `${bold(accent(' Quick Reads'))}  ${bold('Highlights')}`,
    rightPlain,
    view.loading ? `${warn(spinner)} ${ink3('Loading')} ` : ink3(rightPlain),
    cols,
  ), ''];

  if (view.error !== null) {
    frame.push(...wrapText(view.error, cols - 4).map((l) => `  ${err(l)}`), `  ${ink3('Press r to try again.')}`);
  } else if (view.items.length === 0) {
    if (!view.loading) frame.push(`  ${ink3('No highlights yet. Select text in an article in Quick Reads to make one.')}`);
  } else {
    frame.push(...highlightsBody(view, now, cols).lines.slice(view.scroll, view.scroll + height));
  }
  return frame;
}

const HIGHLIGHTS_HINTS = { hints: ['↑/↓ move', '↵ read the article', 'c copy', 'o open'], pinned: ['? keys', 'esc back'] };

export const HELP: [string, string][] = [
  ['↑ ↓  j k', 'Move the selection, or scroll the article'],
  ['space  b', 'Page down, page up'],
  ['g  G', 'Jump to the top, the bottom'],
  ['↵', 'Read the selected article'],
  ['a', 'Archive (or unarchive, in the archive)'],
  ['u', 'Undo the last archive'],
  ['s', 'Save a link to the list you are looking at'],
  ['/', 'Search everything you have saved'],
  ['h', 'Your highlights'],
  ['tab  1 2 3', 'Switch between Queue, To Do, and Archive'],
  ['o', 'Open the original page in your browser'],
  ['c', 'Copy the link (or the highlight)'],
  ['r', 'Refresh'],
  ['esc', 'Go back'],
  ['q', 'Quit'],
];

function helpFrame(cols: number): string[] {
  const frame = [header(' Quick Reads  Keys', `${bold(accent(' Quick Reads'))}  ${bold('Keys')}`, '', '', cols), ''];
  const keyWidth = Math.max(...HELP.map(([k]) => stringWidth(k)));
  for (const [key, what] of HELP) {
    frame.push(truncate(`  ${key.padEnd(keyWidth)}   ${what}`, cols)
      .replace(key.padEnd(keyWidth), bold(key.padEnd(keyWidth))));
  }
  return frame;
}

interface Hints {
  hints: string[];
  pinned: string[];
}

function footer(state: State, hints: Hints, cols: number): string {
  if (state.prompt !== null) {
    const label = state.prompt.kind === 'search' ? 'Search: ' : 'Save link: ';
    const room = cols - stringWidth(label) - 3;
    // A long value scrolls left so the end being typed stays in view.
    const chars = [...state.prompt.value];
    while (chars.length > 0 && stringWidth(chars.join('')) > room) chars.shift();
    return ` ${bold(label)}${chars.join('')}${reverse(' ')}`;
  }
  // A notice speaks in full ink; the hints keep to the margin of attention.
  if (state.notice !== null) return ` ${truncate(state.notice, cols - 1)}`;
  return ink3(` ${fitHints(hints.hints, hints.pinned, cols - 1)}`);
}

/** The whole frame: header, body, footer. Exactly `rows` lines. */
export function renderFrame(state: State, now: Date, cols: number, rows: number): string[] {
  let frame: string[];
  let hints: Hints;
  if (state.screen === 'help') {
    frame = helpFrame(cols);
    hints = { hints: [], pinned: ['Press any key to go back'] };
  } else if (state.screen === 'reader' && state.reader !== null) {
    frame = readerFrame(state, state.reader, cols, rows);
    hints = READER_HINTS;
  } else if (state.screen === 'highlights' && state.highlights !== null) {
    frame = highlightsFrame(state, state.highlights, now, cols, rows);
    hints = HIGHLIGHTS_HINTS;
  } else {
    frame = [listHeader(state, cols), '', ...listBody(state, now, cols, bodyHeight(rows))];
    hints = listHints(state.list);
  }
  while (frame.length < rows - 1) frame.push('');
  frame.length = Math.max(0, rows - 1);
  frame.push(footer(state, hints, cols));
  return frame;
}
