// The real terminal behind the Io the commands are written against.
import type { Io } from './commands.ts';
import { fileRefs } from './refs.ts';
import { page } from './pager.ts';
import { openUrl } from './platform.ts';
import { accent, truncate } from './ansi.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Anything faster than this is not worth announcing: a spinner that flashes
// for a few frames reads as a glitch, not as progress.
const PATIENCE_MS = 150;
const FRAME_MS = 80;
const CLEAR = '\r\x1b[K';

/**
 * A spinner on stderr, so it never ends up in piped output. It appears only
 * if the work outlasts PATIENCE_MS, and takes its line with it when it goes.
 */
function spinner(label: string): () => void {
  const { stderr } = process;
  if (stderr.isTTY !== true) return () => {};
  const text = truncate(label.replace(/\s+/g, ' '), Math.max(8, (stderr.columns || 80) - 4));
  let frame = 0;
  let shown = false;
  let ticking: NodeJS.Timeout | null = null;
  const draw = (): void => {
    shown = true;
    stderr.write(`${CLEAR}${accent(SPINNER[frame++ % SPINNER.length]!)} ${text}`);
  };
  const patience = setTimeout(() => {
    draw();
    ticking = setInterval(draw, FRAME_MS);
  }, PATIENCE_MS);
  return () => {
    clearTimeout(patience);
    if (ticking !== null) clearInterval(ticking);
    if (shown) stderr.write(CLEAR);
    shown = false;
  };
}

export function terminalIo(): Io {
  return {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    isTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    // A terminal that reports no size reports 0, which is not a width.
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows ?? 24,
    now: () => new Date(),
    page: (lines) => page(`${lines.join('\n')}\n`),
    busy: spinner,
    open: openUrl,
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    refs: fileRefs,
  };
}
