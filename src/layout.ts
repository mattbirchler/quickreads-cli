// Blocks to lines. Everything here is a pure function of its input and a
// width, so the `read` command and the interactive reader share it and the
// tests can assert on whole pages of output.
import type { Article, Highlight } from './types.ts';
import { parseHtml, markHighlights, type Block, type Document, type Span, type Style } from './html.ts';
import {
  accent, bold, canTint, hyperlink, ink2, ink3, italic, mark, stringWidth, surface, tagInk, truncate, underline,
} from './ansi.ts';
import { longDate, readingTime, siteOf, titleOf } from './format.ts';

// Prose wider than this is tiring to read however wide the window is.
export const MAX_READING_WIDTH = 80;
// Below this a quote inside a list inside a narrow pane stops being readable;
// the text takes the room and the indentation gives way.
const MIN_TEXT_WIDTH = 16;

interface Piece {
  text: string;
  style: Style;
}

type Unit =
  | { kind: 'word'; pieces: Piece[]; width: number }
  | { kind: 'space'; style: Style }
  | { kind: 'break' };

/**
 * Spans to wrap units. A word is everything between two spaces even when it
 * crosses spans ("bold**,**" or a link marker hugging its link), because a
 * line must never break inside it.
 */
function unitsOf(spans: Span[]): Unit[] {
  const units: Unit[] = [];
  let word: Piece[] = [];
  const endWord = (): void => {
    if (word.length === 0) return;
    units.push({ kind: 'word', pieces: word, width: word.reduce((w, p) => w + stringWidth(p.text), 0) });
    word = [];
  };
  for (const span of spans) {
    if (span.br) {
      endWord();
      units.push({ kind: 'break' });
      continue;
    }
    const { text, br: _, ...style } = span;
    for (const part of text.split(/( )/)) {
      if (part === '') continue;
      if (part === ' ') {
        endWord();
        units.push({ kind: 'space', style });
      } else {
        word.push({ text: part, style });
      }
    }
  }
  endWord();
  return units;
}

/** Cut a word too long for any line (a URL, usually) into line-sized runs. */
function splitWord(pieces: Piece[], width: number): Piece[][] {
  const runs: Piece[][] = [[]];
  let used = 0;
  for (const piece of pieces) {
    let text = '';
    for (const ch of piece.text) {
      const w = stringWidth(ch);
      if (used + w > width && used > 0) {
        if (text !== '') runs[runs.length - 1]!.push({ text, style: piece.style });
        runs.push([]);
        text = '';
        used = 0;
      }
      text += ch;
      used += w;
    }
    if (text !== '') runs[runs.length - 1]!.push({ text, style: piece.style });
  }
  return runs;
}

function wrapUnits(units: Unit[], width: number): Piece[][] {
  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let used = 0;
  let space: Style | null = null;
  const endLine = (): void => {
    lines.push(line);
    line = [];
    used = 0;
    space = null;
  };

  for (const unit of units) {
    if (unit.kind === 'break') {
      endLine();
    } else if (unit.kind === 'space') {
      if (used > 0) space = unit.style;
    } else if (unit.width > width) {
      if (used > 0) endLine();
      const runs = splitWord(unit.pieces, width);
      runs.forEach((run, i) => {
        line = run;
        used = run.reduce((w, p) => w + stringWidth(p.text), 0);
        if (i < runs.length - 1) endLine();
      });
    } else {
      if (used > 0 && used + (space === null ? 0 : 1) + unit.width > width) endLine();
      if (used > 0 && space !== null) {
        line.push({ text: ' ', style: space });
        used += 1;
      }
      space = null;
      line.push(...unit.pieces);
      used += unit.width;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

const styleKey = (s: Style): string =>
  `${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}${s.code ? 'c' : ''}${s.link ? 'l' : ''}${s.note ? 'n' : ''}${s.mark ? 'm' : ''}|${s.href ?? ''}`;

export interface LayoutOptions {
  // Make links clickable. Off by default: the escape sequence is only safe
  // to send straight to a terminal, not through a pager that may print it.
  hyperlinks?: boolean;
}

function paint(text: string, style: Style, base: (s: string) => string, options: LayoutOptions): string {
  let out = text;
  if (style.link) out = underline(out);
  if (style.italic) out = italic(out);
  if (style.bold) out = bold(out);
  // A highlight sets its own ink, so the quieter inks stand down inside one.
  if (style.mark) out = mark(out);
  else if (style.note) out = ink3(out);
  else if (style.code) out = ink2(out);
  else out = base(out);
  return options.hyperlinks === true && style.href !== undefined && !style.note ? hyperlink(style.href, out) : out;
}

function paintLine(pieces: Piece[], base: (s: string) => string, options: LayoutOptions): string {
  let out = '';
  let run = '';
  let runStyle: Style | null = null;
  for (const piece of pieces) {
    if (runStyle !== null && styleKey(runStyle) === styleKey(piece.style)) {
      run += piece.text;
      continue;
    }
    if (runStyle !== null) out += paint(run, runStyle, base, options);
    run = piece.text;
    runStyle = piece.style;
  }
  if (runStyle !== null) out += paint(run, runStyle, base, options);
  return out;
}

const plain = (s: string): string => s;

function baseFor(block: Block): (s: string) => string {
  if (block.kind === 'heading') return block.level <= 2 ? (s) => bold(accent(s)) : bold;
  if (block.caption) return ink2;
  return plain;
}

// The highlighted text on one line of output. The interactive reader uses
// these to open an article at the passage that was picked.
export interface Mark {
  line: number;
  text: string;
}

const markedText = (pieces: Piece[]): string =>
  pieces.filter((p) => p.style.mark && !p.style.note).map((p) => p.text).join('');

function layoutBlock(block: Block, width: number, marks: Mark[], offset: number, options: LayoutOptions): string[] {
  const bar = accent('│') + ' ';
  const quoteCols = block.quote * 2;
  // Indentation yields before the text does.
  const room = Math.max(0, width - quoteCols - MIN_TEXT_WIDTH);
  const indent = Math.min(block.indent, room);
  const hang = Math.min(block.hang, Math.max(0, room - indent));
  const lead = bar.repeat(block.quote) + ' '.repeat(indent);
  const textWidth = Math.max(1, width - quoteCols - indent - hang);

  if (block.kind === 'rule') {
    return [lead + ink3('─'.repeat(Math.max(1, Math.min(textWidth, 24))))];
  }

  if (block.kind === 'pre') {
    const codeWidth = Math.max(1, textWidth - 4);
    const code: string[] = [];
    for (const line of block.lines) {
      const runs = line === '' ? [[]] : splitWord([{ text: line, style: {} }], codeWidth);
      for (const run of runs) code.push(run.map((p) => p.text).join(''));
    }
    // A panel behind the code where the terminal's colour is known. The
    // panel is as wide as its longest line, with a line of padding above and
    // below; without it the indent and the quieter ink do the job.
    if (!canTint()) return code.map((text) => `${lead}  ${ink2(text)}`.trimEnd());
    const panel = Math.max(...code.map((text) => stringWidth(text))) + 4;
    const row = (text: string): string =>
      `${lead}${surface(`  ${ink2(text)}${' '.repeat(panel - 2 - stringWidth(text))}`)}`;
    return [row(''), ...code.map(row), row('')];
  }

  const base = baseFor(block);
  const first = block.bullet === '' ? ' '.repeat(hang) : ink3(block.bullet.padEnd(Math.max(0, hang - 1))) + (hang > 0 ? ' ' : '');
  const rest = ' '.repeat(hang);
  return wrapUnits(unitsOf(block.spans), textWidth).map((pieces, i) => {
    const text = markedText(pieces);
    if (text.trim() !== '') marks.push({ line: offset + i, text });
    return `${lead}${i === 0 ? first : rest}${paintLine(pieces, base, options)}`.trimEnd();
  });
}

// List items sit together; everything else gets air.
const tight = (a: Block, b: Block): boolean =>
  (a.hang > 0 || a.indent > 0) && (b.hang > 0 || b.indent > 0) && a.quote === b.quote && b.kind !== 'heading';

/** The document as lines wrapped to `width`, with a Links section when it has any. */
export function layoutDocument(doc: Document, width: number, marks: Mark[] = [], options: LayoutOptions = {}): string[] {
  const out: string[] = [];
  let previous: Block | null = null;
  for (const block of doc.blocks) {
    if (previous !== null && !tight(previous, block)) {
      // Inside a quote the bar keeps running through the gap.
      const shared = Math.min(previous.quote, block.quote);
      out.push(shared > 0 ? (accent('│') + ' ').repeat(shared).trimEnd() : '');
    }
    out.push(...layoutBlock(block, width, marks, out.length, options));
    previous = block;
  }

  if (doc.links.length > 0) {
    if (out.length > 0) out.push('');
    out.push(ink3('─'.repeat(Math.min(width, 24))), bold('Links'));
    const digits = String(doc.links.length).length;
    doc.links.forEach((href, i) => {
      const label = `[${i + 1}]`.padStart(digits + 2);
      const runs = splitWord([{ text: href, style: {} }], Math.max(1, width - digits - 3));
      runs.forEach((run, j) => {
        const text = run.map((p) => p.text).join('');
        const shown = options.hyperlinks === true ? hyperlink(href, ink2(text)) : ink2(text);
        out.push(`${ink3(j === 0 ? label : ' '.repeat(digits + 2))} ${shown}`);
      });
    });
  }
  return out;
}

/** Plain text wrapped to `width`, for titles, notes, and messages. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const spans: Span[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) spans.push({ text: '', br: true });
    spans.push({ text: line.replace(/\s+/g, ' ').trim() });
  });
  return wrapUnits(unitsOf(spans), width).map((pieces) => pieces.map((p) => p.text).join(''));
}

export interface ReaderOptions extends LayoutOptions {
  width: number;
  highlights?: Highlight[];
  // Show the article's address under its title. On by default; the
  // interactive reader leaves it out, since o and c are one key away.
  showUrl?: boolean;
  // What to say, after the reason, when the article has no text to show.
  emptyHint?: string;
}

function whyEmpty(article: Article): string {
  if (article.fetchBlocked === true) {
    return 'This site would not serve the page to Quick Reads, so only the link was saved.';
  }
  if (article.list === 'todo') return 'A To Do item: a link to act on, with no article text.';
  return 'Only the link was saved for this one. There is no article text.';
}

/** The title block at the top of an article, closed by a short rule. */
export function articleHeader(article: Article, width: number, showUrl = true): string[] {
  const out = wrapText(titleOf(article), width).map((l) => bold(l));
  const published = article.publishedAt === null ? null : new Date(article.publishedAt);
  const length = readingTime(article.wordCount);
  const meta = [
    siteOf(article),
    article.author?.trim() ?? '',
    published === null || Number.isNaN(published.getTime()) ? '' : longDate(published),
    length === '' ? '' : `${length} read`,
  ].filter((s) => s !== '').join(' · ');
  for (const line of wrapText(meta, width)) out.push(ink3(line));
  // Tags in their own colours, as many as fit on one line.
  let tags = '';
  let used = 0;
  for (const tag of article.tags ?? []) {
    const label = `#${tag.name}`;
    const needed = stringWidth(label) + (used === 0 ? 0 : 1);
    if (used + needed > width) break;
    tags += `${used === 0 ? '' : ' '}${tagInk(tag.color, label)}`;
    used += needed;
  }
  if (tags !== '') out.push(tags);
  // A placeholder address goes nowhere, so it is not shown as if it did.
  if (showUrl && article.hasOriginalUrl !== false) out.push(ink3(truncate(article.url, width)));
  out.push(ink3('─'.repeat(Math.min(width, 24))));
  return out;
}

export interface RenderedArticle {
  lines: string[];
  links: string[];
  // Highlights that were found in the text, out of those passed in.
  marked: number;
  // Every line carrying highlighted text, top to bottom.
  marks: Mark[];
}

/**
 * The line a highlight starts on, or null when it is not in the text. The
 * first line of a highlight is the one whose marked text the highlight begins
 * with.
 */
export function lineOfHighlight(marks: Mark[], highlight: string): number | null {
  const wanted = highlight.replace(/\s+/g, ' ').trim();
  if (wanted === '') return null;
  const found = marks.find((m) => m.text.trim() !== '' && wanted.startsWith(m.text.trim()));
  return found?.line ?? null;
}

/** A whole article, header to links, as lines no wider than `options.width`. */
export function renderArticle(article: Article, options: ReaderOptions): RenderedArticle {
  const { width } = options;
  const lines = [...articleHeader(article, width, options.showUrl !== false), ''];

  const content = article.content ?? '';
  const doc = parseHtml(content, article.hasOriginalUrl === false ? undefined : article.url);
  if (doc.blocks.length === 0) {
    const message = [whyEmpty(article), options.emptyHint ?? ''].filter((s) => s !== '').join(' ');
    lines.push(...wrapText(message, width).map((l) => ink2(l)));
    return { lines, links: [], marked: 0, marks: [] };
  }

  const marked = markHighlights(doc, (options.highlights ?? []).map((h) => h.text));
  const marks: Mark[] = [];
  const body = layoutDocument(doc, width, marks, options);
  const top = lines.length;
  lines.push(...body);
  return { lines, links: doc.links, marked, marks: marks.map((m) => ({ ...m, line: m.line + top })) };
}
