import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sentencesOf, wordsOf, firstSelection, stepSentence, resizeBySentence, moveEnd, moveStart, selectedText,
  type Selection,
} from '../src/select.ts';

const texts = (text: string): string[] => sentencesOf(text).map((r) => text.slice(r.from, r.to));

test('a paragraph splits at periods, questions and exclamations', () => {
  assert.deepEqual(texts('It works. Does it? It does! Good.'), ['It works.', 'Does it?', 'It does!', 'Good.']);
});

test('closing quotes and brackets stay with their sentence', () => {
  assert.deepEqual(texts('She said "no." Then she left. (He stayed.) Fine.'), ['She said "no."', 'Then she left.', '(He stayed.)', 'Fine.']);
  assert.deepEqual(texts('He asked, “why?” Nobody knew.'), ['He asked, “why?”', 'Nobody knew.']);
});

test('titles, initials and abbreviations do not end a sentence', () => {
  assert.deepEqual(texts('Dr. Whitlock wrote it. J. K. Rowling did not.'), ['Dr. Whitlock wrote it.', 'J. K. Rowling did not.']);
  assert.deepEqual(texts('Use a pager, e.g. less. It helps.'), ['Use a pager, e.g. less.', 'It helps.']);
  assert.deepEqual(texts('Version 2.5 shipped. Nobody noticed.'), ['Version 2.5 shipped.', 'Nobody noticed.']);
  assert.deepEqual(texts('Try No. 5 first. She said no. He left.'), ['Try No. 5 first.', 'She said no.', 'He left.']);
});

test('an ellipsis ends a sentence only when a new one follows', () => {
  assert.deepEqual(texts('Well... maybe. Or not… Who knows.'), ['Well... maybe.', 'Or not…', 'Who knows.']);
});

test('text with no punctuation is one sentence, and empty text is none', () => {
  assert.deepEqual(texts('  A heading with no period  '), ['A heading with no period']);
  assert.deepEqual(texts(''), []);
  assert.deepEqual(texts('   '), []);
});

test('full-width punctuation needs no space after it', () => {
  assert.deepEqual(texts('これは文です。これも文です。'), ['これは文です。', 'これも文です。']);
});

test('words are what sits between spaces', () => {
  const text = 'one  two, three';
  assert.deepEqual(wordsOf(text).map((w) => text.slice(w.from, w.to)), ['one', 'two,', 'three']);
});

const PROSE = [
  'First one. Second one here. Third.',
  '',
  'Only sentence of the next paragraph.',
];
const show = (sel: Selection | null): string | null => (sel === null ? null : selectedText(PROSE, sel));

test('marking starts on the first sentence at or after a place in the text', () => {
  assert.equal(show(firstSelection(PROSE, 0)), 'First one.');
  assert.equal(show(firstSelection(PROSE, 0, 5)), 'Second one here.');
  // Past the last sentence of a paragraph: the next paragraph's first.
  assert.equal(show(firstSelection(PROSE, 0, 30)), 'Only sentence of the next paragraph.');
  assert.equal(show(firstSelection(PROSE, 1)), 'Only sentence of the next paragraph.');
  // Past the end of everything: the last sentence there is.
  assert.equal(show(firstSelection(PROSE, 2, 99)), 'Only sentence of the next paragraph.');
  assert.equal(firstSelection(['', ''], 0), null);
});

test('stepping moves a sentence at a time, across paragraphs, and stops at the ends', () => {
  let sel = firstSelection(PROSE, 0)!;
  const seen = [show(sel)];
  for (let next = stepSentence(PROSE, sel, 1); next !== null; next = stepSentence(PROSE, sel, 1)) {
    sel = next;
    seen.push(show(sel));
  }
  assert.deepEqual(seen, ['First one.', 'Second one here.', 'Third.', 'Only sentence of the next paragraph.']);
  const back = [];
  for (let prev = stepSentence(PROSE, sel, -1); prev !== null; prev = stepSentence(PROSE, sel, -1)) {
    sel = prev;
    back.push(show(sel));
  }
  assert.deepEqual(back, ['Third.', 'Second one here.', 'First one.']);
});

test('stepping from a resized selection lands on whole sentences', () => {
  const two = resizeBySentence(PROSE, firstSelection(PROSE, 0)!, 1)!;
  assert.equal(show(two), 'First one. Second one here.');
  assert.equal(show(stepSentence(PROSE, two, 1)), 'Third.');
  const middle = moveStart(PROSE, moveEnd(PROSE, firstSelection(PROSE, 0, 5)!, -1)!, 1)!;
  assert.equal(show(middle), 'one');
  assert.equal(show(stepSentence(PROSE, middle, -1)), 'First one.');
  assert.equal(show(stepSentence(PROSE, middle, 1)), 'Third.');
});

test('a selection grows and shrinks by the sentence, inside its paragraph', () => {
  const one = firstSelection(PROSE, 0)!;
  const two = resizeBySentence(PROSE, one, 1)!;
  const three = resizeBySentence(PROSE, two, 1)!;
  assert.equal(show(three), 'First one. Second one here. Third.');
  assert.equal(resizeBySentence(PROSE, three, 1), null);
  assert.equal(show(resizeBySentence(PROSE, three, -1)), 'First one. Second one here.');
  assert.equal(resizeBySentence(PROSE, one, -1), null);
  // Cut short by a word, growing finishes the sentence first.
  assert.equal(show(resizeBySentence(PROSE, moveEnd(PROSE, two, -1)!, 1)), 'First one. Second one here.');
});

test('the end moves by the word and never passes the start', () => {
  const second = firstSelection(PROSE, 0, 5)!;
  assert.equal(show(moveEnd(PROSE, second, -1)), 'Second one');
  assert.equal(show(moveEnd(PROSE, moveEnd(PROSE, second, -1)!, -1)), 'Second');
  assert.equal(moveEnd(PROSE, moveEnd(PROSE, moveEnd(PROSE, second, -1)!, -1)!, -1), null);
  assert.equal(show(moveEnd(PROSE, second, 1)), 'Second one here. Third.');
  assert.equal(moveEnd(PROSE, moveEnd(PROSE, second, 1)!, 1), null);
});

test('the start moves by the word and never passes the end', () => {
  const second = firstSelection(PROSE, 0, 5)!;
  assert.equal(show(moveStart(PROSE, second, 1)), 'one here.');
  assert.equal(show(moveStart(PROSE, moveStart(PROSE, second, 1)!, 1)), 'here.');
  assert.equal(moveStart(PROSE, moveStart(PROSE, moveStart(PROSE, second, 1)!, 1)!, 1), null);
  assert.equal(show(moveStart(PROSE, second, -1)), 'one. Second one here.');
  assert.equal(moveStart(PROSE, firstSelection(PROSE, 0)!, -1), null);
});

test('the quoted text has single spaces, whatever the paragraph had', () => {
  assert.equal(selectedText(['Two  spaces here.'], { block: 0, from: 0, to: 17 }), 'Two spaces here.');
});
