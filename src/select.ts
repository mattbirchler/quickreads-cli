// Choosing a passage to highlight, as arithmetic on text. A selection is a
// range inside one paragraph; the keys move it a sentence at a time and trim
// either end a word at a time. Nothing here knows about the screen.

export interface Range {
  from: number;
  to: number;
}

export interface Selection extends Range {
  // Index into the prose list: which paragraph the range is in.
  block: number;
}

// Words that end in a full stop without ending the sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'fig', 'e.g', 'i.e', 'cf', 'approx',
]);

// Sentence punctuation with its closing quotes, then the gap before the next
// sentence. Full-width punctuation needs no gap after it.
const ENDER = /[.!?…]+["'”’)\]]*(?=\s)|[。！？]+[」』”’]*/g;

/** Trim a range of `text` so it neither starts nor ends on whitespace. */
function trimmed(text: string, from: number, to: number): Range | null {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(text[a]!)) a++;
  while (b > a && /\s/.test(text[b - 1]!)) b--;
  return a < b ? { from: a, to: b } : null;
}

/** The sentences of a paragraph, in order, without the spaces between them. */
export function sentencesOf(text: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  const push = (end: number): void => {
    const range = trimmed(text, start, end);
    if (range !== null) out.push(range);
    start = end;
  };

  for (const match of text.matchAll(ENDER)) {
    const end = match.index + match[0].length;
    const next = /^\s*(\S)/.exec(text.slice(end))?.[1];
    if (match[0].startsWith('.') && !match[0].startsWith('..')) {
      const before = /(\S+)$/.exec(text.slice(start, match.index))?.[1] ?? '';
      const word = before.replace(/^["'“‘(\[]+/, '');
      // "Dr. Whitlock" and "J. K. Rowling" carry on, and so does "No. 5".
      if (ABBREVIATIONS.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
      if (word === 'No' && next !== undefined && /\d/.test(next)) continue;
    }
    // A lower-case letter next means the sentence is still going ("e.g. this").
    if (next !== undefined && /\p{Ll}/u.test(next)) continue;
    push(end);
  }
  push(text.length);
  return out;
}

/** Every run of characters between spaces. */
export function wordsOf(text: string): Range[] {
  return [...text.matchAll(/\S+/g)].map((m) => ({ from: m.index, to: m.index + m[0].length }));
}

const sentences = (prose: string[], block: number): Range[] => sentencesOf(prose[block] ?? '');

function nextBlock(prose: string[], block: number, step: 1 | -1): number | null {
  for (let i = block + step; i >= 0 && i < prose.length; i += step) {
    if (prose[i]!.trim() !== '') return i;
  }
  return null;
}

/**
 * The sentence to start on: the first one beginning at or after `at` in
 * `block`, or failing that the first of a later paragraph, or failing that
 * the last sentence there is.
 */
export function firstSelection(prose: string[], block: number, at = 0): Selection | null {
  for (let i = Math.max(0, block); i < prose.length; i++) {
    const found = sentences(prose, i).find((s) => i > block || s.from >= at);
    if (found !== undefined) return { block: i, ...found };
  }
  for (let i = Math.min(block, prose.length - 1); i >= 0; i--) {
    const all = sentences(prose, i);
    if (all.length > 0) return { block: i, ...all[all.length - 1]! };
  }
  return null;
}

/** One sentence on from the selection, or back. Null at either end of the text. */
export function stepSentence(prose: string[], sel: Selection, step: 1 | -1): Selection | null {
  const all = sentences(prose, sel.block);
  if (step === 1) {
    const next = all.find((s) => s.from >= sel.to);
    if (next !== undefined) return { block: sel.block, ...next };
  } else {
    const before = all.filter((s) => s.to <= sel.from || (s.from < sel.from && s.to < sel.to));
    // A selection trimmed to the middle of a sentence steps back to the
    // sentence before the one it sits in, not to its own beginning.
    const inside = all.findIndex((s) => s.from <= sel.from && sel.from < s.to);
    const previous = inside > 0 ? all[inside - 1] : inside === 0 ? undefined : before[before.length - 1];
    if (previous !== undefined) return { block: sel.block, ...previous };
  }
  const block = nextBlock(prose, sel.block, step);
  if (block === null) return null;
  const there = sentences(prose, block);
  const landed = step === 1 ? there[0] : there[there.length - 1];
  return landed === undefined ? null : { block, ...landed };
}

/** Take in the next sentence, or let the last one go. Null when there is nothing to take or give. */
export function resizeBySentence(prose: string[], sel: Selection, step: 1 | -1): Selection | null {
  const ends = sentences(prose, sel.block).map((s) => s.to);
  const to = step === 1
    ? ends.find((e) => e > sel.to)
    : ends.filter((e) => e > sel.from && e < sel.to).pop();
  return to === undefined ? null : { ...sel, to };
}

/** Move the end of the selection one word. Null when it cannot move. */
export function moveEnd(prose: string[], sel: Selection, step: 1 | -1): Selection | null {
  const ends = wordsOf(prose[sel.block] ?? '').map((w) => w.to);
  const to = step === 1
    ? ends.find((e) => e > sel.to)
    : ends.filter((e) => e > sel.from && e < sel.to).pop();
  return to === undefined ? null : { ...sel, to };
}

/** Move the start of the selection one word. Null when it cannot move. */
export function moveStart(prose: string[], sel: Selection, step: 1 | -1): Selection | null {
  const starts = wordsOf(prose[sel.block] ?? '').map((w) => w.from);
  const from = step === 1
    ? starts.find((s) => s > sel.from && s < sel.to)
    : starts.filter((s) => s < sel.from).pop();
  return from === undefined ? null : { ...sel, from };
}

/** The words of the selection, the way the highlight will quote them. */
export const selectedText = (prose: string[], sel: Selection): string =>
  (prose[sel.block] ?? '').slice(sel.from, sel.to).replace(/\s+/g, ' ').trim();
