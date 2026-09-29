import { spawn } from 'node:child_process';

/**
 * Show text through the reader's pager. Resolves when they quit it. Anything
 * that goes wrong with the pager falls back to printing, because the article
 * matters more than how it scrolls.
 */
export function page(text: string): Promise<void> {
  const pager = process.env['QUICKREADS_PAGER'] ?? process.env['PAGER'] ?? 'less';
  if (pager.trim() === '' || pager.trim() === 'cat') {
    process.stdout.write(text);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (printInstead: boolean): void => {
      if (settled) return;
      settled = true;
      if (printInstead) process.stdout.write(text);
      resolve();
    };
    // PAGER is a command line ("less -S"), so it goes through the shell the
    // way git and man run it. -F quits at once when the article fits on one
    // screen, -R passes colour through, -X leaves the text on screen after.
    const child = spawn(pager, {
      shell: true,
      stdio: ['pipe', 'inherit', 'inherit'],
      env: { ...process.env, LESS: process.env['LESS'] ?? 'FRX' },
    });
    child.on('error', () => done(true));
    child.on('close', (code) => done(code === 127));
    // Quitting the pager before the end closes the pipe; that is not an error.
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}
