// Terminal escape helpers. Colors go through here so every caller degrades to
// plain text together when stdout is not a TTY (or NO_COLOR is set).

export const useColor = (): boolean =>
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

// Primary ink is the terminal's own default foreground so the reader's theme
// stays in charge. Hierarchy comes from weight and two quieter inks; the one
// accent is Quick Reads purple, and the remaining colours each mean something
// (done, warning, error, a highlighted passage). Truecolor where the terminal
// speaks it, the nearest xterm-256 index where it does not.
type Depth = 'truecolor' | '256' | 'basic';

function colorDepth(): Depth {
  const ct = process.env['COLORTERM'] ?? '';
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  if ((process.env['TERM'] ?? '').includes('256color')) return '256';
  return 'basic';
}

interface Ink {
  rgb: [number, number, number];
  xterm: number;
  // What to fall back to when the terminal has only the basic eight.
  basic: string | null;
}

const fg = (ink: Ink) => (s: string): string => {
  if (!useColor() || s === '') return s;
  const depth = colorDepth();
  if (depth === 'truecolor') {
    const [r, g, b] = ink.rgb;
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
export const ink2 = fg({ rgb: [159, 162, 171], xterm: 247, basic: null });
export const ink3 = fg({ rgb: [110, 113, 122], xterm: 243, basic: null });

export const accent = fg({ rgb: [167, 139, 250], xterm: 141, basic: '35' });
export const ok = fg({ rgb: [91, 208, 126], xterm: 78, basic: '32' });
export const warn = fg({ rgb: [224, 165, 66], xterm: 214, basic: '33' });
export const err = fg({ rgb: [255, 122, 114], xterm: 210, basic: '31' });

/**
 * A highlighted passage: dark ink on highlighter yellow, which reads the same
 * on a light theme and a dark one because it sets both colours itself.
 */
export function mark(s: string): string {
  if (!useColor() || s === '') return s;
  const depth = colorDepth();
  const bg = depth === 'truecolor' ? '48;2;250;220;110' : depth === '256' ? '48;5;221' : '43';
  return `\x1b[30;${bg}m${s}\x1b[39;49m`;
}

export const ALT_SCREEN_ON = '\x1b[?1049h\x1b[?25l';
export const ALT_SCREEN_OFF = '\x1b[?25h\x1b[?1049l';
export const HOME = '\x1b[H';
// Erase from the cursor to the end of the line / screen. Rows are written with
// CLEAR_LINE at their end instead of clearing the whole screen first, so a
// repaint never shows a blank frame.
export const CLEAR_LINE = '\x1b[K';
export const CLEAR_BELOW = '\x1b[J';

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
