// The scriptable half of the CLI: one function per subcommand. Each takes the
// API client and an Io, and returns an exit code; nothing here touches
// process.stdout or the filesystem directly, which is what lets the tests run
// a command against a fake server and read back exactly what it printed.
import type { Flags } from './cli.ts';
import { loadForReading, walkArticles, type Client } from './api.ts';
import type { Article, Highlight } from './types.ts';
import type { Ref, RefStore } from './refs.ts';
import { resolveRef } from './refs.ts';
import { bold, ink2, ink3, accent, ok, padStart, stringWidth, stripAnsi, tagInk, truncate } from './ansi.ts';
import { compactTime, count, rowMeta, siteOf, titleOf } from './format.ts';
import { MAX_READING_WIDTH, renderArticle, wrapText } from './layout.ts';
import { findPassage, parseHtml } from './html.ts';

export interface Io {
  out(line: string): void;
  err(line: string): void;
  isTTY: boolean;
  cols: number;
  rows: number;
  now(): Date;
  /** Show long output a screen at a time. */
  page(lines: string[]): Promise<void>;
  /**
   * Say that something slow has started. Returns the function that says it
   * has finished. Quick work never shows anything at all.
   */
  busy(label: string): () => void;
  open(url: string): void;
  readStdin(): Promise<string>;
  stdinIsTTY: boolean;
  refs: RefStore;
}

export interface CommandContext {
  client: Client;
  io: Io;
  flags: Flags;
  args: string[];
}

const DEFAULT_LIMIT = 25;

/** Run `work` with a sign of life on screen for as long as it takes. */
async function waiting<T>(io: Io, label: string, work: Promise<T>): Promise<T> {
  const done = io.busy(label);
  try {
    return await work;
  } finally {
    done();
  }
}

const refOf = (article: Article): Ref => ({ id: article.id, title: titleOf(article) });

/** One numbered row: title on the left, where and when on the right. */
export function articleRow(article: Article, n: number, numberWidth: number, cols: number, now: Date, flagArchived = false): string {
  const number = padStart(String(n), numberWidth);
  const title = titleOf(article);
  const state = flagArchived && article.archivedAt !== null ? 'archived · ' : '';
  const meta = state + rowMeta(article, now);
  const lead = ` ${number}  `;
  const room = cols - stringWidth(lead) - 1;
  const gap = room - stringWidth(title) - stringWidth(meta);
  if (gap >= 2) return `${ink3(lead)}${bold(title)}${' '.repeat(gap)}${ink3(meta)}`;
  // Not enough room for both: the title keeps what it needs down to a
  // readable minimum, and the meta goes entirely before it gets mangled.
  const titleRoom = room - stringWidth(meta) - 2;
  if (titleRoom >= 24) return `${ink3(lead)}${bold(truncate(title, titleRoom))}  ${ink3(meta)}`;
  return `${ink3(lead)}${bold(truncate(title, room))}`;
}

function printArticles(ctx: CommandContext, articles: Article[], empty: string, flagArchived = false): void {
  const { io, flags } = ctx;
  io.refs.save(articles.map(refOf));

  if (flags.json) {
    for (const a of articles) io.out(JSON.stringify(a));
    return;
  }
  if (flags.plain) {
    // Tab-separated and stable: id, savedAt, site, title, url.
    for (const a of articles) io.out([a.id, a.savedAt, siteOf(a), titleOf(a), a.url].map(cell).join('\t'));
    return;
  }
  if (articles.length === 0) {
    io.out(empty);
    return;
  }
  const now = io.now();
  const numberWidth = String(articles.length).length;
  articles.forEach((a, i) => io.out(articleRow(a, i + 1, numberWidth, io.cols, now, flagArchived)));
  if (io.isTTY) io.out(ink3(`\n Read one with \`quickreads read <number>\`.`));
}

// A tab or newline inside a title would break the one-row-per-item promise.
const cell = (s: string): string => s.replace(/[\t\r\n]+/g, ' ');

export async function list(ctx: CommandContext): Promise<number> {
  const { client, flags } = ctx;
  const archived = flags.archived;
  const articles = await waiting(ctx.io, 'Loading', walkArticles(
    client,
    { archived, ...(flags.todo ? { list: 'todo' as const } : {}) },
    flags.limit ?? DEFAULT_LIMIT,
  ));
  const empty = flags.todo
    ? (archived ? 'Nothing done yet.' : 'Nothing to do. Add something with `quickreads save --todo <url>`.')
    : (archived ? 'Your archive is empty.' : 'Your queue is empty. Save something with `quickreads save <url>`.');
  printArticles(ctx, articles, empty);
  return 0;
}

export async function search(ctx: CommandContext): Promise<number> {
  const { client, io, flags, args } = ctx;
  const query = args.join(' ').trim();
  if (query === '' && flags.tag === null) {
    io.err('Search for what? Pass some words, a --tag, or both.');
    return 2;
  }

  let tagId: string | undefined;
  if (flags.tag !== null) {
    const wanted = flags.tag.replace(/^#/, '').trim().toLowerCase();
    const tags = await waiting(io, 'Searching', client.tags());
    const tag = tags.find((t) => t.name.toLowerCase() === wanted);
    if (tag === undefined) {
      io.err(`No tag called "${flags.tag}".${tags.length > 0 ? ` Yours are: ${tags.map((t) => t.name).join(', ')}.` : ''}`);
      return 1;
    }
    tagId = tag.id;
  }

  const articles = await waiting(io, 'Searching', client.search({
    ...(query === '' ? {} : { query }),
    ...(tagId === undefined ? {} : { tagId }),
    limit: flags.limit ?? DEFAULT_LIMIT,
  }));
  printArticles(ctx, articles, query === '' ? 'Nothing has that tag.' : `Nothing matches "${query}".`, true);
  return 0;
}

/** Resolve <article>, or say why not. */
function articleFrom(ctx: CommandContext, input: string | undefined): Ref | null {
  const resolved = resolveRef(input ?? '', ctx.io.refs.load());
  if (!resolved.ok) {
    ctx.io.err(resolved.error);
    return null;
  }
  return resolved.ref;
}

export async function read(ctx: CommandContext): Promise<number> {
  const { client, io, flags, args } = ctx;
  const ref = articleFrom(ctx, args[0]);
  if (ref === null) return 2;

  const { article, highlights } = await waiting(
    io,
    ref.title === '' ? 'Opening' : `Opening ${ref.title}`,
    loadForReading(client, ref.id),
  );

  if (flags.json) {
    io.out(JSON.stringify(article));
    return 0;
  }

  const margin = io.isTTY && !flags.plain ? 2 : 0;
  const width = flags.width ?? Math.max(20, Math.min(MAX_READING_WIDTH, io.cols - margin * 2));
  const render = (hyperlinks: boolean): string[] => {
    const { lines } = renderArticle(article, {
      width,
      highlights,
      hyperlinks,
      emptyHint: `Open it with \`quickreads open ${args[0]}\`.`,
    });
    const pad = ' '.repeat(margin);
    return lines.map((l) => (l === '' ? '' : pad + (flags.plain ? stripAnsi(l) : l)));
  };

  // Links are clickable when the article goes straight to the terminal. A
  // pager may print the escape sequence instead of obeying it, so paged
  // output goes without.
  const text = render(false);
  if (io.isTTY && !flags.plain && !flags.noPager && text.length > io.rows - 2) await io.page(text);
  else for (const line of io.isTTY && !flags.plain ? render(true) : text) io.out(line);
  return 0;
}

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // "https://notaurl" parses, but nobody means a bare word.
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.href;
  } catch {
    return null;
  }
}

function describeSaved(article: Article, wantedTodo: boolean): string[] {
  const where = article.list === 'todo' ? 'To Do' : 'your queue';
  const lines = [`${ok('✓')} Saved to ${where}: ${bold(titleOf(article))}`];
  if (wantedTodo && article.list !== 'todo') {
    lines.push(ink2('  To Do is hidden on this account, so it went to the queue instead.'));
  }
  if (article.fetchBlocked === true) {
    lines.push(ink2('  The site would not serve the page to Quick Reads, so only the link was saved.'));
  } else if (article.type === 'link' && article.list !== 'todo') {
    lines.push(ink2('  The page could not be read, so only the link was saved.'));
  }
  return lines;
}

export async function save(ctx: CommandContext): Promise<number> {
  const { client, io, flags, args } = ctx;

  if (flags.text) {
    if (io.stdinIsTTY) {
      io.err('--text reads from standard input. Try `pbpaste | quickreads save --text`.');
      return 2;
    }
    const text = await io.readStdin();
    if (text.trim() === '') {
      io.err('There was nothing on standard input to save.');
      return 1;
    }
    const article = await waiting(io, 'Saving', client.saveText(text, flags.title ?? undefined));
    if (flags.json) io.out(JSON.stringify(article));
    else if (flags.plain) io.out([article.id, titleOf(article), ''].map(cell).join('\t'));
    else for (const line of describeSaved(article, false)) io.out(line);
    return 0;
  }

  let inputs = args;
  // `pbpaste | quickreads save` and `cat links.txt | quickreads save`.
  if (inputs.length === 0 && !io.stdinIsTTY) {
    inputs = (await io.readStdin()).split(/\s+/).filter((s) => s !== '');
  }
  if (inputs.length === 0) {
    io.err('Save what? Pass a URL, or pipe some in.');
    return 2;
  }

  let failed = 0;
  for (const input of inputs) {
    const url = normalizeUrl(input);
    if (url === null) {
      io.err(`${input} does not look like a web address.`);
      failed += 1;
      continue;
    }
    try {
      const result = await waiting(io, `Saving ${url}`, client.save(url, {
        ...(flags.todo ? { list: 'todo' as const } : {}),
        ...(flags.title !== null ? { title: flags.title } : {}),
      }));
      if (flags.json) {
        io.out(JSON.stringify(result.alreadySaved ? { ...result, url } : result.article));
      } else if (result.alreadySaved) {
        const where = result.readerUrl ?? (result.articleId === null ? '' : client.readerUrl(result.articleId));
        if (flags.plain) io.out([result.articleId ?? '', '', url].join('\t'));
        else io.out(`${accent('•')} Already saved: ${url}${where === '' ? '' : ink3(`\n  ${where}`)}`);
      } else if (flags.plain) {
        io.out([result.article.id, titleOf(result.article), result.article.url].map(cell).join('\t'));
      } else {
        for (const line of describeSaved(result.article, flags.todo)) io.out(line);
      }
    } catch (err) {
      // One bad URL in a batch should not cost the rest of it.
      if (inputs.length === 1) throw err;
      io.err(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }
  return failed > 0 ? 1 : 0;
}

/** A highlight as lines: a bar down the left, the note underneath. */
export function highlightLines(h: Highlight, width: number, indent: string): string[] {
  const out = wrapText(h.text, Math.max(10, width - stringWidth(indent) - 2))
    .map((l) => `${indent}${accent('▎')} ${l}`);
  const note = h.note?.trim() ?? '';
  if (note !== '') {
    wrapText(note, Math.max(10, width - stringWidth(indent) - 8)).forEach((l, i) => {
      out.push(`${indent}  ${ink2(i === 0 ? `Note: ${l}` : `      ${l}`)}`);
    });
  }
  return out;
}

function printHighlightRows(ctx: CommandContext, highlights: Highlight[]): void {
  const { io, flags } = ctx;
  if (flags.json) {
    for (const h of highlights) io.out(JSON.stringify(h));
    return;
  }
  // Tab-separated: articleId, createdAt, text, note.
  for (const h of highlights) io.out([h.articleId, h.createdAt, h.text, h.note ?? ''].map(cell).join('\t'));
}

/** Highlight a passage: `quickreads highlight 3 "the words to keep"`. */
export async function highlight(ctx: CommandContext): Promise<number> {
  const { client, io, flags, args } = ctx;
  if (args[0] === undefined) {
    io.err('Highlight what? Pass an article, then the passage: `quickreads highlight 3 "the words to keep"`.');
    return 2;
  }
  const ref = articleFrom(ctx, args[0]);
  if (ref === null) return 2;

  // `pbpaste | quickreads highlight 3` quotes what is on the clipboard.
  let passage = args.slice(1).join(' ');
  if (passage.trim() === '' && !io.stdinIsTTY) passage = await io.readStdin();
  if (passage.trim() === '') {
    io.err('Highlight which passage? Pass it after the article, or pipe it in.');
    return 2;
  }

  const { article, highlights: existing } = await waiting(io, 'Loading', loadForReading(client, ref.id));
  const title = titleOf(article);
  const quoted = findPassage(parseHtml(article.content ?? ''), passage);
  if (quoted === null) {
    io.err((article.content ?? '') === ''
      ? `${title} has no text to highlight.`
      : `That passage is not in ${title}. A highlight has to quote the article's own words.`);
    return 1;
  }

  const already = existing.find((h) => h.text.replace(/\s+/g, ' ').trim() === quoted);
  const made = already ?? await waiting(io, 'Highlighting', client.highlight(article.id, quoted, flags.note ?? undefined));
  if (flags.json) io.out(JSON.stringify(made));
  // Tab-separated: id, articleId, text, note.
  else if (flags.plain) io.out([made.id, made.articleId, made.text, made.note ?? ''].map(cell).join('\t'));
  else {
    io.out(already === undefined ? `${ok('✓')} Highlighted in ${bold(title)}` : `${accent('•')} Already highlighted in ${bold(title)}`);
    for (const line of highlightLines(made, Math.min(io.cols, MAX_READING_WIDTH + 6), ' ')) io.out(line);
  }
  return 0;
}

export async function highlights(ctx: CommandContext): Promise<number> {
  const { client, io, flags, args } = ctx;
  const width = Math.min(io.cols, MAX_READING_WIDTH + 6);
  const now = io.now();

  if (args[0] !== undefined) {
    const ref = articleFrom(ctx, args[0]);
    if (ref === null) return 2;
    const [found, article] = await waiting(io, 'Loading', Promise.all([
      client.articleHighlights(ref.id),
      ref.title === '' ? client.article(ref.id).catch(() => null) : Promise.resolve(null),
    ]));
    if (flags.json || flags.plain) {
      printHighlightRows(ctx, found);
      return 0;
    }
    const title = ref.title !== '' ? ref.title : article === null ? ref.id : titleOf(article);
    if (found.length === 0) {
      io.out(`No highlights in ${bold(title)}.`);
      return 0;
    }
    io.out(`${bold(title)}  ${ink3(count(found.length, 'highlight'))}`);
    for (const h of found) {
      io.out('');
      for (const line of highlightLines(h, width, ' ')) io.out(line);
    }
    return 0;
  }

  const limit = flags.limit ?? DEFAULT_LIMIT;
  const found: Highlight[] = [];
  let total = 0;
  const done = io.busy('Loading');
  try {
    // The API caps a page at 200; a bigger ask walks.
    while (found.length < limit) {
      const want = Math.min(200, limit - found.length);
      const page = await client.highlights({ limit: want, offset: found.length });
      total = page.total;
      found.push(...page.highlights);
      if (page.highlights.length < want) break;
    }
  } finally {
    done();
  }

  // Each numbered row is a highlight; the number opens its article.
  io.refs.save(found.map((h) => ({ id: h.articleId, title: h.articleTitle?.trim() || '' })));
  if (flags.json || flags.plain) {
    printHighlightRows(ctx, found);
    return 0;
  }
  if (found.length === 0) {
    io.out('No highlights yet. Select text in an article in Quick Reads to make one.');
    return 0;
  }

  const numberWidth = String(found.length).length;
  const indent = ' '.repeat(numberWidth + 3);
  found.forEach((h, i) => {
    if (i > 0) io.out('');
    const from = [h.articleTitle?.trim() || '(untitled)', h.siteName?.trim() ?? '', compactTime(new Date(h.createdAt), now)]
      .filter((s) => s !== '');
    const head = truncate(from.join(' · '), Math.max(10, io.cols - stringWidth(indent) - 1));
    io.out(`${ink3(` ${padStart(String(i + 1), numberWidth)}  `)}${ink3(head)}`);
    for (const line of highlightLines(h, width, indent)) io.out(line);
  });
  if (total > found.length) io.out(ink3(`\n Showing ${found.length} of ${total}. Ask for more with --limit.`));
  else if (io.isTTY) io.out(ink3('\n Read the article behind one with `quickreads read <number>`.'));
  return 0;
}

async function setArchived(ctx: CommandContext, archived: boolean): Promise<number> {
  const { client, io, flags, args } = ctx;
  if (args.length === 0) {
    io.err(`${archived ? 'Archive' : 'Unarchive'} what? Pass a row number or an article id.`);
    return 2;
  }
  // Resolve every argument before changing anything: `archive 1 2 3` must mean
  // the rows as listed, and a typo should stop the whole thing, not half of it.
  const refs: Ref[] = [];
  for (const arg of args) {
    const ref = articleFrom(ctx, arg);
    if (ref === null) return 2;
    refs.push(ref);
  }
  for (const ref of refs) {
    const name = ref.title === '' ? ref.id : ref.title;
    await waiting(
      io,
      `${archived ? 'Archiving' : 'Unarchiving'} ${name}`,
      archived ? client.archive(ref.id) : client.unarchive(ref.id),
    );
    if (flags.json) io.out(JSON.stringify({ id: ref.id, archived }));
    else if (flags.plain) io.out([ref.id, archived ? 'archived' : 'queue'].join('\t'));
    else io.out(`${ok('✓')} ${archived ? 'Archived' : 'Back in the queue'}: ${bold(name)}`);
  }
  return 0;
}

export const archive = (ctx: CommandContext): Promise<number> => setArchived(ctx, true);
export const unarchive = (ctx: CommandContext): Promise<number> => setArchived(ctx, false);

/** Where "open" should go: the original page, or Quick Reads when there is none. */
export function destinationOf(article: Article, client: Client): string {
  return article.hasOriginalUrl === false ? client.readerUrl(article.id) : article.url;
}

export async function open(ctx: CommandContext): Promise<number> {
  const { client, io, args } = ctx;
  const ref = articleFrom(ctx, args[0]);
  if (ref === null) return 2;
  const article = await waiting(io, 'Opening', client.article(ref.id));
  const url = destinationOf(article, client);
  io.open(url);
  io.out(`${ok('✓')} Opened ${bold(titleOf(article))}\n${ink3(`  ${url}`)}`);
  return 0;
}

export async function tags(ctx: CommandContext): Promise<number> {
  const { client, io, flags } = ctx;
  const found = await waiting(io, 'Loading', client.tags());
  if (flags.json) {
    for (const t of found) io.out(JSON.stringify(t));
    return 0;
  }
  if (flags.plain) {
    for (const t of found) io.out([t.id, t.name, String(t.articleCount ?? 0)].map(cell).join('\t'));
    return 0;
  }
  if (found.length === 0) {
    io.out('No tags yet.');
    return 0;
  }
  const widest = Math.max(...found.map((t) => stringWidth(t.name)));
  for (const t of found) {
    const gap = ' '.repeat(widest - stringWidth(t.name) + 2);
    io.out(` ${tagInk(t.color, '●')} ${bold(t.name)}${gap}${ink3(count(t.articleCount ?? 0, 'article'))}`);
  }
  if (io.isTTY) io.out(ink3('\n See what has one with `quickreads search --tag <name>`.'));
  return 0;
}

export async function whoami(ctx: CommandContext): Promise<number> {
  const { client, io, flags } = ctx;
  const account = await waiting(io, 'Loading', client.me());
  if (flags.json) io.out(JSON.stringify(account));
  else if (flags.plain) io.out([account.email, account.tier].join('\t'));
  else io.out(`${bold(account.email)}  ${ink3(`${account.tier} · ${client.serverUrl}`)}`);
  return 0;
}

export const COMMANDS: Record<string, (ctx: CommandContext) => Promise<number>> = {
  list, ls: list,
  read,
  save, add: save,
  search, find: search,
  highlights,
  highlight,
  archive,
  unarchive,
  open,
  tags,
  whoami,
};
