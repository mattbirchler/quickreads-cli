// Painting only. State in, lines out, so the tests can assert a whole frame
// without a terminal. Every frame is exactly `rows` lines tall and no line is
// wider than `cols`.
//
// Nothing here depends on colour to be understood. The selected row has a
// bar in its gutter as well as a wash behind it, the current tab has brackets
// when it cannot have weight, and a progress bar is drawn in two different
// characters. Colour is the finish, not the structure.
import type { Article, Highlight } from '../types.ts';
import {
  accent, bold, canTint, err, ink2, ink3, italic, ok, selected, stringWidth, surface, tagInk, truncate,
  underline, useColor,
} from '../ansi.ts';
import {
  ageOf, compactTime, count, dayGroup, lengthOf, progressOf, rowMeta, siteOf, timeLeft, titleOf,
} from '../format.ts';
import { wrapText, MAX_READING_WIDTH } from '../layout.ts';
import {
  TABS, TAB_LABEL,
  type HighlightsView, type ListView, type Notice, type ReaderView, type State, type Tab, type View,
} from './state.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spinnerOf = (state: State): string => SPINNER[state.spin % SPINNER.length]!;

// Header, a blank line under it, and the footer.
export const CHROME_ROWS = 3;
export const bodyHeight = (rows: number): number => Math.max(1, rows - CHROME_ROWS);

/** The reading column: how wide, and how far in from the left edge. */
export function readingColumn(cols: number): { width: number; margin: number } {
  const width = Math.max(20, Math.min(MAX_READING_WIDTH, cols - 4));
  return { width, margin: Math.max(0, Math.floor((cols - width) / 2)) };
}

// ── Lines from segments ────────────────────────────────────────────────────

// A run of text and how to paint it. Widths are always measured on the text,
// then the paint goes on, so an escape code never counts as a column.
interface Seg {
  text: string;
  paint?: (s: string) => string;
}

const seg = (text: string, paint?: (s: string) => string): Seg => (paint === undefined ? { text } : { text, paint });
const widthOf = (segs: Seg[]): number => segs.reduce((w, s) => w + stringWidth(s.text), 0);
const painted = (segs: Seg[]): string => segs.map((s) => (s.paint === undefined ? s.text : s.paint(s.text))).join('');

// The least a flexible segment is worth showing at. Below this the right
// side gives up its place instead.
const MIN_FLEX = 12;

/**
 * One line, exactly `width` wide: `left` from the left edge, `right` against
 * the right edge, spaces between. `flex` is the index of the left segment
 * that shortens to make everything fit (a title, an excerpt). `edge` columns
 * at the far right stay empty whatever happens.
 */
export function composeLine(left: Seg[], right: Seg[], width: number, flex: number, edge = 0): string {
  const cols = Math.max(0, width - edge);
  const margin = ' '.repeat(width - cols);
  const flexible = stringWidth(left[flex]?.text ?? '');
  const fixed = widthOf(left) - flexible;
  let rightSide = right;
  let room = cols - fixed - widthOf(rightSide) - (rightSide.length > 0 ? 2 : 0);
  // The right side keeps its place unless that would squeeze the flexible
  // text below what is worth showing. Text already shorter than that is not
  // being squeezed.
  if (room < Math.min(MIN_FLEX, flexible) && rightSide.length > 0) {
    rightSide = [];
    room = cols - fixed;
  }
  const leftSide = left.map((s, i) => (i === flex ? { ...s, text: truncate(s.text, Math.max(0, room)) } : s));
  const used = widthOf(leftSide) + widthOf(rightSide);
  if (used > cols) {
    // Narrower than the fixed parts alone. Say what fits and stop.
    const plain = truncate(leftSide.map((s) => s.text).join(''), cols);
    return plain + ' '.repeat(Math.max(0, cols - stringWidth(plain))) + margin;
  }
  return `${painted(leftSide)}${' '.repeat(cols - used)}${painted(rightSide)}${margin}`;
}

/** Done in the accent and a heavy line, the rest in a light one. */
export function progressBar(fraction: number, width: number): Seg[] {
  const clamped = Math.max(0, Math.min(1, fraction));
  // Any progress at all shows as at least one cell, and only the end fills the bar.
  let done = Math.round(clamped * width);
  if (clamped > 0 && done === 0) done = 1;
  if (clamped < 1 && done === width) done = width - 1;
  return [seg('━'.repeat(done), accent), seg('─'.repeat(width - done), ink3)];
}

// ── Header ─────────────────────────────────────────────────────────────────

const WORDMARK: Seg = seg(' Quick Reads', (s) => bold(accent(s)));

function tabSeg(tab: Tab, current: Tab | null): Seg {
  const label = TAB_LABEL[tab];
  if (tab !== current) return seg(` ${label} `, ink3);
  // Weight and a wash mark the current list. Without styling, brackets do.
  if (!useColor()) return seg(`[${label}]`);
  if (canTint()) return seg(` ${label} `, (s) => selected(bold(s)));
  return seg(` ${label} `, (s) => bold(underline(s)));
}

function headerLine(left: Seg[], right: Seg[], cols: number): string {
  // Where you are matters more than the count: the right side goes first.
  const fits = widthOf(left) + widthOf(right) + 2 <= cols;
  return composeLine([...left, seg('')], fits ? right : [], cols, left.length);
}

function loadingSegs(state: State): Seg[] {
  return [seg(spinnerOf(state), accent), seg(' Loading ', ink3)];
}

function listHeader(state: State, cols: number): string {
  const { list } = state;
  const left: Seg[] = [WORDMARK, seg('   ')];
  if (list.source.kind === 'search') {
    left.push(seg('Search  ', ink3), seg(truncate(list.source.query, Math.max(8, cols - 40)), bold));
  } else {
    for (const tab of TABS) left.push(tabSeg(tab, list.source.kind));
  }

  let right: Seg[] = [];
  if (list.loading) right = loadingSegs(state);
  else if (list.error === null) {
    const noun = list.source.kind === 'search' ? 'match' : list.source.kind === 'todo' ? 'item' : 'article';
    const plural = noun === 'match' ? 'matches' : `${noun}s`;
    const n = list.items.length;
    const text = list.exhausted || list.source.kind === 'search' ? count(n, noun, plural) : `${n}+ ${plural}`;
    if (list.loadingMore) right.push(seg(`${spinnerOf(state)} `, accent));
    right.push(seg(`${text} `, ink3));
  }
  return headerLine(left, right, cols);
}

// ── List ───────────────────────────────────────────────────────────────────

const GUTTER = 3;
const EDGE = 2;
const PROGRESS_WIDTH = 6;

export const rowHeight = (view: View): number => (view === 'roomy' ? 2 : 1);

const gutter = (isSelected: boolean): Seg => (isSelected ? seg(' ▍ ', accent) : seg('   '));

const oneLine = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

export interface RowOptions {
  selected: boolean;
  view: View;
  // Search results come from every list, so they say which ones are archived.
  flagArchived: boolean;
  // To Do rows carry an open circle, the thing `a` ticks off.
  todo: boolean;
}

/** One article as one or two lines, each exactly `cols` wide. */
export function listRow(article: Article, now: Date, cols: number, options: RowOptions): string[] {
  const title = (options.todo ? '○ ' : '') + titleOf(article);
  const archived = options.flagArchived && article.archivedAt !== null;
  const finish = (line: string): string => (options.selected ? selected(line) : line);

  if (options.view === 'compact') {
    const meta = (archived ? 'archived · ' : '') + rowMeta(article, now);
    return [finish(composeLine([gutter(options.selected), seg(title, bold)], [seg(meta, ink3)], cols, 1, EDGE))];
  }

  const progress = progressOf(article);
  const top: Seg[] = [];
  if (progress !== null) top.push(...progressBar(progress, PROGRESS_WIDTH), seg('  '));
  top.push(seg(ageOf(article, now), ink3));

  const site = siteOf(article);
  const length = lengthOf(article);
  const facts = [archived ? 'archived' : '', length].filter((s) => s !== '');
  const under: Seg[] = [seg(' '.repeat(GUTTER))];
  if (site !== '') under.push(seg(site, ink2));
  if (facts.length > 0) under.push(seg(`${site === '' ? '' : ' · '}${facts.join(' · ')}`, ink3));
  const excerpt = oneLine(article.excerpt);
  const lead = under.length > 1 && excerpt !== '' ? '  ' : '';
  under.push(seg(lead + excerpt, ink3));

  const tags: Seg[] = [];
  for (const tag of article.tags ?? []) {
    if (tags.length > 0) tags.push(seg(' '));
    tags.push(seg(`#${tag.name}`, (s) => tagInk(tag.color, s)));
  }

  return [
    finish(composeLine([gutter(options.selected), seg(title, bold)], top, cols, 1, EDGE)),
    finish(composeLine(under, tags, cols, under.length - 1, EDGE)),
  ];
}

export interface Block {
  // Body line the item starts on, and how many lines it takes.
  start: number;
  height: number;
  // Lines of heading directly above it, which scroll into view with it.
  lead: number;
}

function groupHeading(label: string, cols: number): string {
  const rule = '─'.repeat(Math.max(0, cols - GUTTER - stringWidth(label) - 1 - EDGE));
  return composeLine([seg(' '.repeat(GUTTER)), seg(label, ink2), seg(' '), seg(rule, ink3), seg('')], [], cols, 4, EDGE);
}

/** The list as lines, with where each article landed among them. */
export function listBody(list: ListView, view: View, now: Date, cols: number): { lines: string[]; blocks: Block[] } {
  const lines: string[] = [];
  const blocks: Block[] = [];
  // Search results are ranked, not dated, so they are not filed under days.
  const grouped = list.source.kind !== 'search';
  let group: string | null = null;

  list.items.forEach((article, i) => {
    let lead = 0;
    if (grouped) {
      const { key, label } = dayGroup(new Date(article.archivedAt ?? article.savedAt), now);
      if (key !== group) {
        group = key;
        if (lines.length > 0) { lines.push(''); lead += 1; }
        lines.push(groupHeading(label, cols));
        lead += 1;
      }
    }
    const row = listRow(article, now, cols, {
      selected: i === list.selected,
      view,
      flagArchived: list.source.kind === 'search',
      todo: list.source.kind === 'todo',
    });
    blocks.push({ start: lines.length, height: row.length, lead });
    lines.push(...row);
  });
  return { lines, blocks };
}

// Placeholder rows of differing lengths, so the list that is coming has a
// shape before it has any words.
const SKELETON_TITLES = [38, 27, 46, 31, 42, 24, 35];
const SHIMMER = 5;

function skeletonBar(length: number, cols: number, spin: number, offset: number): string {
  const width = Math.max(4, Math.min(length, cols - GUTTER - EDGE));
  // A brighter patch that crosses the bar and comes round again.
  const at = ((spin * 3 + offset) % (cols + SHIMMER * 4)) - SHIMMER;
  let out = '';
  for (let i = 0; i < width; i++) {
    out += i >= at && i < at + SHIMMER ? ink2('▒') : ink3('░');
  }
  return `${' '.repeat(GUTTER)}${out}`;
}

function skeleton(state: State, cols: number, height: number): string[] {
  const lines = [groupHeading('Today', cols)];
  for (let i = 0; lines.length + rowHeight(state.view) <= height && i < SKELETON_TITLES.length; i++) {
    lines.push(skeletonBar(SKELETON_TITLES[i]!, cols, state.spin, i * 2));
    if (state.view === 'roomy') lines.push(skeletonBar(SKELETON_TITLES[i]! + 18, cols, state.spin, i * 2 + 1));
  }
  return lines;
}

function emptyLead(list: ListView): string {
  switch (list.source.kind) {
    case 'queue': return 'Your queue is empty. Press s to save a link.';
    case 'todo': return 'Nothing to do. Press s to add a link.';
    case 'archive': return 'Nothing archived yet.';
    case 'search': return `Nothing matches "${list.source.query}". Press / to search again.`;
  }
}

const message = (text: string, cols: number, paint: (s: string) => string): string[] =>
  wrapText(text, Math.max(10, cols - GUTTER - EDGE)).map((l) => `${' '.repeat(GUTTER)}${paint(l)}`);

function listLines(state: State, now: Date, cols: number, height: number): string[] {
  const { list } = state;
  if (list.error !== null) {
    return [...message(list.error, cols, err), '', ...message('Press r to try again.', cols, ink3)];
  }
  if (list.items.length === 0) {
    return list.loading ? skeleton(state, cols, height) : message(emptyLead(list), cols, ink3);
  }
  return listBody(list, state.view, now, cols).lines.slice(list.scroll, list.scroll + height);
}

// ── Footer ─────────────────────────────────────────────────────────────────

export type Hint = [key: string, does: string];

export interface Hints {
  hints: Hint[];
  // Never cut: how to see every key, and how to leave.
  pinned: Hint[];
}

const hintWidth = (hints: Hint[]): number =>
  hints.reduce((w, [key, does]) => w + stringWidth(key) + 1 + stringWidth(does), 0) + Math.max(0, hints.length - 1) * 3;

/**
 * As many hints as fit, in order of usefulness. The pinned ones are what a
 * person stuck on a narrow terminal needs most, so they are the last to go,
 * and the way out is never cut at all.
 */
export function fitHints({ hints, pinned }: Hints, room: number): Hint[] {
  const shown = [...hints];
  while (shown.length > 0 && hintWidth([...shown, ...pinned]) > room) shown.pop();
  const kept = [...pinned];
  while (kept.length > 1 && hintWidth([...shown, ...kept]) > room) kept.shift();
  return [...shown, ...kept];
}

// The key in full ink, what it does in the quiet one.
const paintHints = (hints: Hint[]): string =>
  hints.map(([key, does]) => `${key} ${ink3(does)}`).join('   ');

const TONE_MARK: Record<Exclude<Notice['tone'], 'busy'>, Seg> = {
  ok: seg('✓', ok),
  error: seg('✕', err),
  info: seg('•', accent),
};

function footer(state: State, hints: Hints, cols: number): string {
  if (state.prompt !== null) {
    const label = state.prompt.kind === 'search' ? 'Search ' : 'Save link ';
    const room = cols - stringWidth(label) - 4;
    // A long value scrolls left so the end being typed stays in view.
    const chars = [...state.prompt.value];
    while (chars.length > 0 && stringWidth(chars.join('')) > room) chars.shift();
    return ` ${accent('›')} ${bold(label)}${chars.join('')}${useColor() ? selected(' ') : '▏'}`;
  }
  if (state.notice !== null) {
    const mark = state.notice.tone === 'busy' ? seg(spinnerOf(state), accent) : TONE_MARK[state.notice.tone];
    return ` ${painted([mark])} ${truncate(state.notice.text, cols - 4)}`;
  }
  const shown = fitHints(hints, cols - 2);
  // Narrower than the way out itself: say as much of it as fits.
  if (hintWidth(shown) > cols - 2) return ` ${truncate(shown.map(([k, d]) => `${k} ${d}`).join('   '), cols - 2)}`;
  return ` ${paintHints(shown)}`;
}

function listHints(list: ListView): Hints {
  const archive = list.source.kind === 'archive' ? 'unarchive' : list.source.kind === 'todo' ? 'done' : 'archive';
  return {
    hints: [['↑↓', 'move'], ['↵', 'read'], ['a', archive], ['/', 'search'], ['s', 'save'], ['h', 'highlights'], ['tab', 'lists']],
    pinned: [['?', 'keys'], list.source.kind === 'search' ? ['esc', 'back'] : ['q', 'quit']],
  };
}

const READER_HINTS: Hints = {
  hints: [['↑↓', 'scroll'], ['space', 'page'], ['a', 'archive'], ['o', 'open'], ['c', 'copy link']],
  pinned: [['?', 'keys'], ['esc', 'back']],
};

const HIGHLIGHTS_HINTS: Hints = {
  hints: [['↑↓', 'move'], ['↵', 'read the article'], ['c', 'copy'], ['o', 'open']],
  pinned: [['?', 'keys'], ['esc', 'back']],
};

// ── Reader ─────────────────────────────────────────────────────────────────

const READER_BAR = 12;

function readerFrame(state: State, reader: ReaderView, cols: number, rows: number): string[] {
  const height = bodyHeight(rows);
  const { margin } = readingColumn(cols);
  const total = reader.lines.length;

  let right: Seg[] = [];
  if (reader.loading) right = loadingSegs(state);
  else if (reader.error === null && total > height) {
    // How much has been seen, which is the bottom of the screen, not the top.
    const fraction = Math.min(1, (reader.scroll + height) / total);
    const left = timeLeft(reader.article.wordCount, fraction);
    if (left !== '') right.push(seg(`${left}  `, ink3));
    right.push(...progressBar(fraction, READER_BAR), seg(`  ${String(Math.round(fraction * 100)).padStart(3)}% `, ink3));
  }

  const crumb: Seg[] = [WORDMARK, seg('   ')];
  // The bar gives way before the title does, and the time left before the bar.
  while (right.length > 0 && widthOf(crumb) + widthOf(right) + 2 + MIN_FLEX > cols) right = right.slice(1);
  const frame = [composeLine([...crumb, seg(titleOf(reader.article), ink2)], right, cols, crumb.length), ''];

  const pad = ' '.repeat(margin);
  if (reader.error !== null) frame.push(...message(reader.error, cols, err));
  else {
    for (const line of reader.lines.slice(reader.scroll, reader.scroll + height)) {
      frame.push(line === '' ? '' : pad + line);
    }
  }
  return frame;
}

// ── Highlights ─────────────────────────────────────────────────────────────

/** The highlights screen body, with where each highlight landed in it. */
export function highlightsBody(view: HighlightsView, now: Date, cols: number): { lines: string[]; blocks: Block[] } {
  const lines: string[] = [];
  const blocks: Block[] = [];
  view.items.forEach((h, i) => {
    let lead = 0;
    if (i > 0) { lines.push(''); lead = 1; }
    const block = highlightBlock(h, i === view.selected, now, cols);
    blocks.push({ start: lines.length, height: block.length, lead });
    lines.push(...block);
  });
  return { lines, blocks };
}

function highlightBlock(h: Highlight, isSelected: boolean, now: Date, cols: number): string[] {
  const width = Math.max(10, Math.min(cols - GUTTER - 2 - EDGE, MAX_READING_WIDTH));
  const finish = (line: string): string => (isSelected ? selected(line) : line);
  const title = oneLine(h.articleTitle) || '(untitled)';
  const from = [oneLine(h.siteName), compactTime(new Date(h.createdAt), now)].filter((s) => s !== '').join(' · ');

  const out = [finish(composeLine(
    [gutter(isSelected), seg(title, isSelected ? bold : ink2)],
    [seg(from, ink3)],
    cols,
    1,
    EDGE,
  ))];
  const bar = seg('▎ ', isSelected ? accent : ink3);
  for (const l of wrapText(h.text, width)) {
    out.push(finish(composeLine([seg(' '.repeat(GUTTER)), bar, seg(l), seg('')], [], cols, 3)));
  }
  const note = oneLine(h.note);
  if (note !== '') {
    wrapText(note, width - 6).forEach((l, i) => {
      const text = i === 0 ? `Note: ${l}` : `      ${l}`;
      out.push(finish(composeLine([seg(' '.repeat(GUTTER + 2)), seg(text, (s) => italic(ink2(s))), seg('')], [], cols, 2)));
    });
  }
  return out;
}

function highlightsFrame(state: State, view: HighlightsView, now: Date, cols: number, rows: number): string[] {
  const height = bodyHeight(rows);
  let right: Seg[];
  if (view.loading) right = loadingSegs(state);
  else {
    const text = view.total > view.items.length
      ? `${view.items.length} of ${view.total}`
      : count(view.items.length, 'highlight');
    right = [seg(`${text} `, ink3)];
  }
  const frame = [headerLine([WORDMARK, seg('   '), seg('Highlights', bold)], right, cols), ''];

  if (view.error !== null) {
    frame.push(...message(view.error, cols, err), '', ...message('Press r to try again.', cols, ink3));
  } else if (view.items.length === 0) {
    if (!view.loading) {
      frame.push(...message('No highlights yet. Select text in an article in Quick Reads to make one.', cols, ink3));
    }
  } else {
    frame.push(...highlightsBody(view, now, cols).lines.slice(view.scroll, view.scroll + height));
  }
  return frame;
}

// ── Help ───────────────────────────────────────────────────────────────────

export const HELP: { title: string; keys: Hint[] }[] = [
  { title: 'Move', keys: [['↑ ↓ j k', 'Move or scroll'], ['space b', 'Page down, page up'], ['g G', 'Top, bottom']] },
  { title: 'Read', keys: [['↵', 'Read the article'], ['o', 'Open in your browser'], ['c', 'Copy link or highlight']] },
  { title: 'Organize', keys: [['a', 'Archive or unarchive'], ['u', 'Undo the last archive'], ['s', 'Save a link']] },
  { title: 'Find', keys: [['/', 'Search your library'], ['h', 'Highlights'], ['tab 1 2 3', 'Switch lists']] },
  { title: 'View', keys: [['v', 'Roomy or compact rows'], ['r', 'Refresh']] },
  { title: 'Leave', keys: [['esc', 'Go back'], ['q', 'Quit']] },
];

const HELP_KEY = 11;
const HELP_DOES = 24;
const HELP_COLUMN = HELP_KEY + HELP_DOES;
const HELP_BLANK: Seg[] = [seg(' '.repeat(HELP_COLUMN))];

/**
 * Sections stacked into a column. `depths` says how many key rows each
 * section gets, so that two columns side by side can keep their section
 * titles on the same lines.
 */
function helpColumn(sections: typeof HELP, titled: boolean, depths: number[] = []): Seg[][] {
  const out: Seg[][] = [];
  sections.forEach((section, i) => {
    if (titled) {
      if (i > 0) out.push(HELP_BLANK);
      out.push([seg(section.title.padEnd(HELP_COLUMN), accent)]);
    }
    for (const [key, does] of section.keys) {
      out.push([seg(key.padEnd(HELP_KEY), bold), seg(does.padEnd(HELP_DOES), ink2)]);
    }
    for (let n = section.keys.length; n < (depths[i] ?? 0); n++) out.push(HELP_BLANK);
  });
  return out;
}

function helpFrame(cols: number, rows: number): string[] {
  const frame = [headerLine([WORDMARK, seg('   '), seg('Keys', bold)], [], cols), ''];
  const height = bodyHeight(rows);

  // Two columns where there is room for them, one where there is not.
  // Section titles go when that is what it takes to get every key on screen,
  // and unevenly filled sections stop being padded to match their neighbour.
  const two = cols >= HELP_COLUMN * 2 + 10;
  const half = Math.ceil(HELP.length / 2);
  const depths = HELP.slice(0, half).map((s, i) => Math.max(s.keys.length, HELP[half + i]?.keys.length ?? 0));
  const build = (titled: boolean): Seg[][][] => (two
    ? [helpColumn(HELP.slice(0, half), titled, titled ? depths : []), helpColumn(HELP.slice(half), titled, titled ? depths : [])]
    : [helpColumn(HELP, titled)]);
  const tallest = (cs: Seg[][][]): number => Math.max(...cs.map((c) => c.length));
  let columns = build(true);
  if (tallest(columns) + 4 > height) {
    // Titles are worth keeping without the panel, if that is enough.
    if (tallest(columns) > height || tallest(build(false)) + 4 <= height) columns = build(false);
  }
  const inner = columns.length * HELP_COLUMN + (columns.length - 1) * 4 + 4;
  const depth = Math.max(...columns.map((c) => c.length));
  if (inner + 2 > cols || depth + 4 > height) {
    // Too narrow or too short for a panel. The keys matter more than the
    // frame around them, so the frame is what goes.
    for (let i = 0; i < depth; i++) {
      const segs = columns.flatMap((c, n) => [seg(n === 0 ? ' ' : '    '), ...(c[i] ?? HELP_BLANK)]);
      // Styled text cannot be cut safely, so a row that has to be cut goes plain.
      frame.push(widthOf(segs) > cols ? truncate(segs.map((s) => s.text).join('').trimEnd(), cols) : painted(segs));
    }
    return frame;
  }

  const margin = ' '.repeat(Math.max(0, Math.floor((cols - inner - 2) / 2)));
  const side = ink3('│');
  const row = (content: string): string => `${margin}${side}${surface(content)}${side}`;
  const blank = ' '.repeat(inner);

  frame.push(`${margin}${ink3(`╭${'─'.repeat(inner)}╮`)}`, row(blank));
  for (let i = 0; i < depth; i++) {
    const cells = columns.map((c) => painted(c[i] ?? HELP_BLANK));
    frame.push(row(`  ${cells.join('    ')}  `));
  }
  frame.push(row(blank), `${margin}${ink3(`╰${'─'.repeat(inner)}╯`)}`);

  // Centred in the height that is left, when there is any to spare.
  const spare = height - (frame.length - 2);
  if (spare > 1) frame.splice(2, 0, ...Array<string>(Math.floor(spare / 2)).fill(''));
  return frame;
}

// ── Frame ──────────────────────────────────────────────────────────────────

/** The whole frame: header, body, footer. Exactly `rows` lines. */
export function renderFrame(state: State, now: Date, cols: number, rows: number): string[] {
  let frame: string[];
  let hints: Hints;
  if (state.screen === 'help') {
    frame = helpFrame(cols, rows);
    hints = { hints: [], pinned: [['any key', 'closes this']] };
  } else if (state.screen === 'reader' && state.reader !== null) {
    frame = readerFrame(state, state.reader, cols, rows);
    hints = READER_HINTS;
  } else if (state.screen === 'highlights' && state.highlights !== null) {
    frame = highlightsFrame(state, state.highlights, now, cols, rows);
    hints = HIGHLIGHTS_HINTS;
  } else {
    frame = [listHeader(state, cols), '', ...listLines(state, now, cols, bodyHeight(rows))];
    hints = listHints(state.list);
  }
  while (frame.length < rows - 1) frame.push('');
  frame.length = Math.max(0, rows - 1);
  frame.push(footer(state, hints, cols));
  return frame;
}
