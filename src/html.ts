// Article content arrives as sanitized HTML. This turns it into a short list
// of blocks (paragraphs, headings, list items, quotes, code) whose text is
// runs of styled spans, which is everything layout.ts needs to wrap prose for
// a terminal. Not a general HTML parser, and it does not need to be: the
// server has already sanitized the input, so what is left is article markup.
// Anything unexpected degrades to plain text rather than failing.

export interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  // Link text: underlined, and followed by a numbered marker.
  link?: boolean;
  // Where the link goes, for terminals that can open it on a click.
  href?: string;
  // Apparatus rather than prose: link markers, image descriptions.
  note?: boolean;
  // Part of a passage the reader highlighted.
  mark?: boolean;
  // Part of the passage being chosen for a new highlight.
  pick?: boolean;
}

export interface Span extends Style {
  text: string;
  // A hard line break (<br>). Carries no text.
  br?: boolean;
}

export interface Block {
  kind: 'text' | 'heading' | 'pre' | 'rule';
  // Heading level 1 to 6; 0 for everything else.
  level: number;
  spans: Span[];
  // The lines of a code block, whitespace intact.
  lines: string[];
  // Blockquote nesting depth.
  quote: number;
  // Columns of indentation owed to enclosing lists.
  indent: number;
  // The list marker on a list item's first block ('•', ' 1.'), else ''.
  bullet: string;
  // Columns the text hangs past `indent`, so wrapped lines align under the
  // item's first word rather than under its bullet.
  hang: number;
  caption: boolean;
}

export interface Document {
  blocks: Block[];
  // Link targets, in order of first appearance. A marker [n] in the text
  // refers to links[n - 1].
  links: string[];
}

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', trade: '™', reg: '®',
  middot: '·', bull: '•', laquo: '«', raquo: '»', deg: '°',
  times: '×', euro: '€', pound: '£', cent: '¢', sect: '§',
  rarr: '→', larr: '←', frac12: '½', shy: '', zwj: '', zwnj: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isNaN(cp) || cp > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole;
  });
}

// A comment, a tag (with quoted attribute values that may contain '>'), a run
// of text, or a stray '<' that is just a character.
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)|</g;

// Content that is never prose.
const SKIP = new Set(['script', 'style', 'svg', 'iframe', 'noscript', 'template', 'head', 'object', 'audio', 'video']);
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr', 'col', 'embed']);
// Elements that end the block in progress when they open or close.
const BREAKS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'caption', 'figure', 'dl', 'dt', 'dd',
  'details', 'summary', 'address', 'center',
]);
const BOLD = new Set(['b', 'strong']);
const ITALIC = new Set(['i', 'em', 'cite', 'dfn', 'var']);
const CODE = new Set(['code', 'kbd', 'samp', 'tt']);

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  if (match === null) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? '');
}

// A link worth a marker: something a person could follow from a terminal.
function resolveHref(href: string | null, baseUrl: string | undefined): string | null {
  if (href === null) return null;
  const trimmed = href.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  try {
    const url = baseUrl === undefined ? new URL(trimmed) : new URL(trimmed, baseUrl);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const sameStyle = (a: Style, b: Style): boolean =>
  !a.bold === !b.bold && !a.italic === !b.italic && !a.code === !b.code &&
  !a.link === !b.link && !a.note === !b.note && !a.mark === !b.mark && a.href === b.href;

/**
 * One block's spans, tidied: whitespace collapsed to single spaces (across
 * span boundaries too), none at the edges of the block or around a hard
 * break, neighbours of the same style merged.
 */
export function tidySpans(spans: Span[]): Span[] {
  const out: Span[] = [];
  // True at the start of the block, after a break, and after a space.
  let atEdge = true;
  for (const span of spans) {
    if (span.br) {
      trimEnd(out);
      if (out.length > 0 && !out[out.length - 1]!.br) out.push({ text: '', br: true });
      atEdge = true;
      continue;
    }
    let text = span.text.replace(/\s+/g, ' ');
    if (atEdge) text = text.replace(/^ /, '');
    if (text === '') continue;
    atEdge = text.endsWith(' ');
    const last = out[out.length - 1];
    if (last !== undefined && !last.br && sameStyle(last, span)) last.text += text;
    else out.push({ ...span, text });
  }
  trimEnd(out);
  // A block cannot end on a break.
  while (out.length > 0 && out[out.length - 1]!.br) out.pop();
  return out;
}

function trimEnd(spans: Span[]): void {
  while (spans.length > 0) {
    const last = spans[spans.length - 1]!;
    if (last.br) return;
    last.text = last.text.replace(/ +$/, '');
    if (last.text !== '') return;
    spans.pop();
  }
}

interface ListState {
  ordered: boolean;
  next: number;
  hang: number;
}

/** Article HTML to blocks. `baseUrl` resolves relative links. */
export function parseHtml(html: string, baseUrl?: string): Document {
  const blocks: Block[] = [];
  const links: string[] = [];

  let spans: Span[] = [];
  let heading = 0;
  let quote = 0;
  let caption = false;
  const lists: ListState[] = [];
  let pendingBullet = '';

  let bold = 0;
  let italic = 0;
  let code = 0;
  let skip = 0;
  // Assigned from the open/close closures, which the type checker cannot see
  // from the token loop; the cast keeps it from narrowing this to null.
  let pre = null as string | null;
  let link: { href: string; from: number } | null = null;

  const indentOf = (): number => lists.slice(0, -1).reduce((sum, l) => sum + l.hang, 0);
  const hangOf = (): number => lists[lists.length - 1]?.hang ?? 0;

  const flush = (): void => {
    const tidy = tidySpans(spans);
    spans = [];
    if (link !== null) link.from = 0;
    if (tidy.length === 0) return;
    blocks.push({
      kind: heading > 0 ? 'heading' : 'text',
      level: heading,
      spans: tidy,
      lines: [],
      quote,
      indent: indentOf(),
      bullet: pendingBullet,
      hang: hangOf(),
      caption,
    });
    pendingBullet = '';
  };

  const style = (): Style => {
    const s: Style = {};
    if (bold > 0) s.bold = true;
    if (italic > 0 || caption) s.italic = true;
    if (code > 0) s.code = true;
    if (link !== null) {
      s.link = true;
      s.href = link.href;
    }
    return s;
  };

  const open = (name: string, attrs: string): void => {
    if (name === 'br') {
      if (pre !== null) pre += '\n';
      else spans.push({ text: '', br: true });
    } else if (pre !== null) {
      // Markup inside a code block (syntax highlighting spans) is ignored.
    } else if (name === 'hr') {
      flush();
      blocks.push({ kind: 'rule', level: 0, spans: [], lines: [], quote, indent: indentOf() + hangOf(), bullet: '', hang: 0, caption: false });
    } else if (name === 'img') {
      const alt = attribute(attrs, 'alt')?.replace(/\s+/g, ' ').trim() ?? '';
      if (alt !== '') spans.push({ text: `[Image: ${alt}]`, note: true });
    } else if (/^h[1-6]$/.test(name)) {
      flush();
      heading = Number(name[1]);
    } else if (name === 'blockquote') {
      flush();
      quote += 1;
    } else if (name === 'ul' || name === 'ol') {
      flush();
      const ordered = name === 'ol';
      const start = Number.parseInt(attribute(attrs, 'start') ?? '1', 10);
      lists.push({ ordered, next: Number.isNaN(start) ? 1 : start, hang: ordered ? 4 : 2 });
    } else if (name === 'li') {
      flush();
      const list = lists[lists.length - 1];
      if (list === undefined) pendingBullet = '•';
      else if (list.ordered) pendingBullet = `${String(list.next++).padStart(2)}.`;
      else pendingBullet = '•';
    } else if (name === 'pre') {
      flush();
      pre = '';
    } else if (name === 'figcaption') {
      flush();
      caption = true;
    } else if (name === 'td' || name === 'th') {
      // A table row reads as its cells, separated; a terminal column grid
      // cannot hold prose-width cells anyway.
      if (tidySpans(spans.map((s) => ({ ...s }))).length > 0) spans.push({ text: ' · ', note: true });
    } else if (name === 'a') {
      const href = resolveHref(attribute(attrs, 'href'), baseUrl);
      link = href === null ? null : { href, from: spans.length };
    } else if (BOLD.has(name)) bold += 1;
    else if (ITALIC.has(name)) italic += 1;
    else if (CODE.has(name)) code += 1;
    else if (BREAKS.has(name)) flush();
  };

  const close = (name: string): void => {
    if (name === 'pre') {
      if (pre !== null) {
        const lines = decodeEntities(pre).replace(/\t/g, '  ').replace(/\r/g, '').split('\n');
        while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
        while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
        if (lines.length > 0) {
          blocks.push({ kind: 'pre', level: 0, spans: [], lines, quote, indent: indentOf() + hangOf(), bullet: '', hang: 0, caption: false });
        }
      }
      pre = null;
    } else if (pre !== null) {
      // Still inside the code block.
    } else if (/^h[1-6]$/.test(name)) {
      flush();
      heading = 0;
    } else if (name === 'blockquote') {
      flush();
      quote = Math.max(0, quote - 1);
    } else if (name === 'ul' || name === 'ol') {
      flush();
      lists.pop();
      pendingBullet = '';
    } else if (name === 'li') {
      flush();
      pendingBullet = '';
    } else if (name === 'figcaption') {
      flush();
      caption = false;
    } else if (name === 'a') {
      if (link !== null) {
        const said = spans.slice(link.from).map((s) => s.text).join('').replace(/\s+/g, ' ').trim();
        // A link whose text is its own address needs no marker pointing at it.
        const bare = said === link.href || said === link.href.replace(/^https?:\/\//, '').replace(/\/$/, '');
        if (said !== '' && !bare) {
          let n = links.indexOf(link.href) + 1;
          if (n === 0) n = links.push(link.href);
          const { link: _, href: __, ...rest } = style();
          spans.push({ ...rest, text: `[${n}]`, note: true });
        }
      }
      link = null;
    } else if (BOLD.has(name)) bold = Math.max(0, bold - 1);
    else if (ITALIC.has(name)) italic = Math.max(0, italic - 1);
    else if (CODE.has(name)) code = Math.max(0, code - 1);
    else if (BREAKS.has(name)) flush();
  };

  for (const token of html.matchAll(TOKEN)) {
    const [whole, slash, rawName, attrs, text] = token;
    if (rawName !== undefined) {
      const name = rawName.toLowerCase();
      const closing = slash === '/';
      if (SKIP.has(name)) {
        if (closing) skip = Math.max(0, skip - 1);
        else if (!attrs?.trimEnd().endsWith('/')) skip += 1;
        continue;
      }
      if (skip > 0) continue;
      if (closing) close(name);
      else {
        open(name, attrs ?? '');
        if (!VOID.has(name) && attrs?.trimEnd().endsWith('/') && !BREAKS.has(name)) close(name);
      }
      continue;
    }
    if (skip > 0 || whole.startsWith('<!--')) continue;
    const raw = text ?? whole;
    if (pre !== null) pre += raw;
    else spans.push({ ...style(), text: decodeEntities(raw) });
  }
  flush();

  return { blocks, links };
}

/** A block's prose as one string, the way a highlight would quote it. */
export function blockText(block: Block): string {
  return block.spans.map((s) => (s.br ? ' ' : s.note ? '' : s.text)).join('');
}

/**
 * Mark the passages the reader highlighted. Each highlight is matched as
 * text: inside one block when it fits there, otherwise across consecutive
 * blocks (a highlight that runs from the end of one paragraph into the next).
 * Returns how many highlights were found; one that no longer matches the
 * article text is simply not marked.
 */
export function markHighlights(doc: Document, highlights: string[]): number {
  const prose = doc.blocks
    .map((block, index) => ({ block, index, text: blockText(block) }))
    .filter((b) => b.block.kind !== 'pre' && b.block.kind !== 'rule' && b.text !== '');
  let found = 0;

  for (const raw of highlights) {
    const wanted = raw.replace(/\s+/g, ' ').trim();
    if (wanted === '') continue;

    const within = prose.find((b) => b.text.includes(wanted));
    if (within !== undefined) {
      const at = within.text.indexOf(wanted);
      markRange(within.block, at, at + wanted.length);
      found += 1;
      continue;
    }

    for (let i = 0; i < prose.length; i++) {
      const ranges = spanningMatch(prose.map((b) => b.text), i, wanted);
      if (ranges === null) continue;
      ranges.forEach((r, offset) => markRange(prose[i + offset]!.block, r.from, r.to));
      found += 1;
      break;
    }
  }
  return found;
}

// The shortest overlap trusted to start a multi-block match. Below this a
// common word at the end of a paragraph could claim a highlight it never had.
const MIN_OVERLAP = 8;

function spanningMatch(texts: string[], start: number, wanted: string): { from: number; to: number }[] | null {
  const first = texts[start]!;
  for (let k = Math.min(first.length, wanted.length - 1); k >= MIN_OVERLAP; k--) {
    if (!first.endsWith(wanted.slice(0, k))) continue;
    const ranges = [{ from: first.length - k, to: first.length }];
    let rest = wanted.slice(k).trimStart();
    for (let j = start + 1; rest !== '' && j < texts.length; j++) {
      const text = texts[j]!;
      if (rest.startsWith(text)) {
        ranges.push({ from: 0, to: text.length });
        rest = rest.slice(text.length).trimStart();
      } else if (text.startsWith(rest)) {
        ranges.push({ from: 0, to: rest.length });
        rest = '';
      } else {
        break;
      }
    }
    if (rest === '') return ranges;
  }
  return null;
}

/** Style [from, to) of a block's prose, splitting spans at the edges. */
function styleRange(block: Block, from: number, to: number, key: 'mark' | 'pick'): void {
  const out: Span[] = [];
  let at = 0;
  for (const span of block.spans) {
    if (span.br) {
      out.push(span);
      at += 1;
      continue;
    }
    if (span.note) {
      // Markers take no room in the prose; one that sits inside the passage
      // joins it so the highlight is not broken by a gap.
      out.push(at > from && at < to ? { ...span, [key]: true } : span);
      continue;
    }
    const end = at + span.text.length;
    const a = Math.max(from, at);
    const b = Math.min(to, end);
    if (a >= b) {
      out.push(span);
    } else {
      if (a > at) out.push({ ...span, text: span.text.slice(0, a - at) });
      out.push({ ...span, text: span.text.slice(a - at, b - at), [key]: true });
      if (b < end) out.push({ ...span, text: span.text.slice(b - at) });
    }
    at = end;
  }
  block.spans = out;
}

const markRange = (block: Block, from: number, to: number): void => styleRange(block, from, to, 'mark');

/**
 * Each block's prose, by block index, with '' for the blocks a highlight
 * cannot be made in (code, rules, anything empty). Offsets into these strings
 * are what a selection is measured in.
 */
export function proseOf(doc: Document): string[] {
  return doc.blocks.map((b) => (b.kind === 'pre' || b.kind === 'rule' ? '' : blockText(b)));
}

/**
 * Show a passage as chosen. With `brackets` it is also fenced in square
 * brackets, for a terminal where styling is off and the fence is all there is.
 */
export function markSelection(doc: Document, selection: { block: number; from: number; to: number }, brackets = false): void {
  const block = doc.blocks[selection.block];
  if (block === undefined || selection.from >= selection.to) return;
  styleRange(block, selection.from, selection.to, 'pick');
  if (!brackets) return;
  const first = block.spans.findIndex((s) => s.pick);
  if (first < 0) return;
  const last = block.spans.findLastIndex((s) => s.pick);
  // Notes take no room in the prose, so the fence moves no offsets.
  block.spans.splice(last + 1, 0, { text: ']', note: true, pick: true });
  block.spans.splice(first, 0, { text: '[', note: true, pick: true });
}

/** HTML to plain text, one paragraph per line. For excerpts and search. */
export function htmlToText(html: string): string {
  return parseHtml(html).blocks
    .map((b) => (b.kind === 'pre' ? b.lines.join('\n') : blockText(b)))
    .filter((t) => t !== '')
    .join('\n\n');
}
