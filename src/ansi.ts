// Terminal escape helpers. Colors go through here so every caller degrades to
// plain text together when stdout is not a TTY (or NO_COLOR is set).

export const useColor = (): boolean =>
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

// Primary ink is the terminal's own default foreground so the reader's theme
// stays in charge. Hierarchy comes from weight and two quieter inks; the one
// accent is Quick Reads purple, and the remaining colors each mean something
// (done, warning, error, a highlighted passage, a tag's own color).
// Truecolor where the terminal speaks it, the nearest xterm-256 index where
// it does not.
type Depth = 'truecolor' | '256' | 'basic';

export type Rgb = [number, number, number];

function colorDepth(): Depth {
  const ct = process.env['COLORTERM'] ?? '';
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  if ((process.env['TERM'] ?? '').includes('256color')) return '256';
  return 'basic';
}

// What is behind the text. Null until the terminal has been asked (see
// tui/probe.ts), and for every command that never asks. Everything that
// depends on it has a fallback that needs no answer.
let background: Rgb | null = null;

export function setBackground(rgb: Rgb | null): void {
  background = rgb;
}

export const getBackground = (): Rgb | null => background;

const luminance = ([r, g, b]: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Dark unless the terminal said otherwise: most are, and the dark inks are the gentler mistake. */
export const isDark = (): boolean => background === null || luminance(background) < 0.5;

/** Whether a background tint can be mixed from the terminal's own color. */
export const canTint = (): boolean =>
  useColor() && colorDepth() === 'truecolor' && background !== null;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

interface Ink {
  // For dark backgrounds, and for light ones when `light` is absent.
  rgb: Rgb;
  // The same color with enough weight to read on a light background.
  light?: Rgb;
  xterm: number;
  // What to fall back to when the terminal has only the basic eight.
  basic: string | null;
}

const fg = (ink: Ink) => (s: string): string => {
  if (!useColor() || s === '') return s;
  const depth = colorDepth();
  if (depth === 'truecolor') {
    const [r, g, b] = !isDark() && ink.light !== undefined ? ink.light : ink.rgb;
    return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  }
  if (depth === '256') return `\x1b[38;5;${ink.xterm}m${s}\x1b[39m`;
  return ink.basic === null ? `\x1b[2m${s}\x1b[22m` : `\x1b[${ink.basic}m${s}\x1b[39m`;
};

const wrap = (code: string, reset: string) => (s: string): string =>
  useColor() && s !== '' ? `\x1b[${code}m${s}\x1b[${reset}m` : s;

export const bold = wrap('1', '22');
export const dim = wrap('2', '22');
export const italic = wrap('3', '23');
export const underline = wrap('4', '24');
export const reverse = wrap('7', '27');

// Mid grays chosen to read on light and dark terminal themes alike.
export const ink2 = fg({ rgb: [159, 162, 171], light: [92, 96, 105], xterm: 247, basic: null });
export const ink3 = fg({ rgb: [110, 113, 122], light: [138, 141, 150], xterm: 243, basic: null });

const ACCENT: Ink = { rgb: [167, 139, 250], light: [124, 58, 237], xterm: 141, basic: '35' };
export const accent = fg(ACCENT);
export const ok = fg({ rgb: [91, 208, 126], light: [22, 140, 70], xterm: 78, basic: '32' });
export const warn = fg({ rgb: [224, 165, 66], light: [180, 110, 10], xterm: 214, basic: '33' });
export const err = fg({ rgb: [255, 122, 114], light: [210, 50, 45], xterm: 210, basic: '31' });

// The tag palette Quick Reads assigns from. A color this list has never
// heard of falls back to the quiet ink rather than guessing.
const TAG_INKS: Record<string, Ink> = {
  blue: { rgb: [96, 165, 250], light: [37, 99, 235], xterm: 75, basic: '34' },
  purple: { rgb: [167, 139, 250], light: [124, 58, 237], xterm: 141, basic: '35' },
  orange: { rgb: [251, 146, 60], light: [214, 88, 12], xterm: 208, basic: '33' },
  green: { rgb: [74, 222, 128], light: [22, 140, 70], xterm: 78, basic: '32' },
  yellow: { rgb: [250, 204, 21], light: [170, 120, 4], xterm: 220, basic: '33' },
  red: { rgb: [248, 113, 113], light: [210, 50, 45], xterm: 210, basic: '31' },
  gray: { rgb: [156, 163, 175], light: [107, 114, 128], xterm: 247, basic: null },
};

export function tagInk(color: string, s: string): string {
  const ink = TAG_INKS[color];
  return ink === undefined ? ink2(s) : fg(ink)(s);
}

const bg = (rgb: Rgb, s: string): string =>
  (s === '' ? s : `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[49m`);

/**
 * The selected row. A wash of the accent over the terminal's own background
 * when that is known, which keeps every ink on the row legible; plain reverse
 * video when it is not, which works on any terminal ever made.
 *
 * The text may carry its own colors. They all reset the foreground only, so
 * the wash survives them.
 */
export function selected(s: string): string {
  if (!canTint()) return reverse(s);
  const accentRgb = isDark() ? ACCENT.rgb : ACCENT.light!;
  return bg(mix(background!, accentRgb, isDark() ? 0.24 : 0.14), s);
}

/**
 * The passage being chosen for a highlight. Stronger than the selected row,
 * because it sits in running text rather than owning a whole line.
 */
export function pick(s: string): string {
  if (!canTint()) return reverse(s);
  const accentRgb = isDark() ? ACCENT.rgb : ACCENT.light!;
  return bg(mix(background!, accentRgb, isDark() ? 0.5 : 0.28), s);
}

/**
 * A raised surface (a code block, the help panel): the background nudged
 * toward the ink. Without a known background there is no surface, and the
 * caller's own ink has to carry the distinction.
 */
export function surface(s: string): string {
  if (!canTint()) return s;
  return bg(mix(background!, isDark() ? [255, 255, 255] : [0, 0, 0], isDark() ? 0.07 : 0.05), s);
}

/**
 * A highlighted passage: dark ink on highlighter yellow, which reads the same
 * on a light theme and a dark one because it sets both colors itself.
 */
export function mark(s: string): string {
  if (!useColor() || s === '') return s;
  const depth = colorDepth();
  const back = depth === 'truecolor' ? '48;2;250;220;110' : depth === '256' ? '48;5;221' : '43';
  return `\x1b[30;${back}m${s}\x1b[39;49m`;
}

/** Text that opens `url` when clicked, in terminals that do that. The rest show the text. */
export function hyperlink(url: string, s: string): string {
  if (!useColor() || s === '') return s;
  // Control characters in the address would end the sequence early.
  // eslint-disable-next-line no-control-regex
  const safe = url.replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]8;;${safe}\x07${s}\x1b]8;;\x07`;
}

export const ALT_SCREEN_ON = '\x1b[?1049h\x1b[?25l';
export const ALT_SCREEN_OFF = '\x1b[?25h\x1b[?1049l';
export const HOME = '\x1b[H';
// Erase from the cursor to the end of the line / screen. Rows are written with
// CLEAR_LINE at their end instead of clearing the whole screen first, so a
// repaint never shows a blank frame.
export const CLEAR_LINE = '\x1b[K';
export const CLEAR_BELOW = '\x1b[J';
// Synchronized output: the terminal holds the frame until it is complete, so
// a repaint lands whole instead of being seen halfway drawn.
export const SYNC_ON = '\x1b[?2026h';
export const SYNC_OFF = '\x1b[?2026l';
// Alternate scroll: on the alternate screen the wheel sends arrow keys. It
// scrolls the list and the article without taking the mouse away from the
// terminal, so selecting text to copy still works.
export const WHEEL_ON = '\x1b[?1007h';
export const WHEEL_OFF = '\x1b[?1007l';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

/** The text with every escape sequence removed. */
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

/**
 * Cells a string occupies in the terminal, not code points: CJK and emoji take
 * two columns, and a truncation that miscounts them walks rows off the edge.
 * Expects unstyled text; measure before styling.
 */
export function stringWidth(s: string): number {
  let width = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // Control characters render as nothing, and so do the joiners and
    // variation selectors that ride along inside emoji.
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

// The wide ranges that matter in practice: CJK, Hangul, full-width forms, and
// most emoji. Not exhaustive Unicode; a rare miss costs one column of drift on
// one row, which is recoverable, and the full table is not worth a dependency.
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Cut to `max` columns, with an ellipsis when something was lost. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  if (stringWidth(s) <= max) return s;
  let out = '';
  let width = 0;
  for (const ch of s) {
    const w = stringWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** Pad with spaces on the right to exactly `width` columns (truncating if over). */
export function padEnd(s: string, width: number): string {
  const cut = truncate(s, width);
  return cut + ' '.repeat(Math.max(0, width - stringWidth(cut)));
}

/** Pad with spaces on the left to at least `width` columns. */
export function padStart(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - stringWidth(s))) + s;
}
