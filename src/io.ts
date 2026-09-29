// The real terminal behind the Io the commands are written against.
import type { Io } from './commands.ts';
import { fileRefs } from './refs.ts';
import { page } from './pager.ts';
import { openUrl } from './platform.ts';

export function terminalIo(): Io {
  return {
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    isTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    now: () => new Date(),
    page: (lines) => page(`${lines.join('\n')}\n`),
    open: openUrl,
    async readStdin() {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    refs: fileRefs,
  };
}
