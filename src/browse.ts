// The interactive browser's terminal: alternate screen, raw keyboard, and a
// promise that the shell gets its screen back however this ends. Decisions
// live in tui/app.ts; this file only owns the real devices.
import type { Client } from './api.ts';
import { createApp, type Terminal } from './tui/app.ts';
import {
  ALT_SCREEN_ON, ALT_SCREEN_OFF, HOME, CLEAR_LINE, CLEAR_BELOW, SYNC_ON, SYNC_OFF, WHEEL_ON, WHEEL_OFF, setBackground,
} from './ansi.ts';
import { probeBackground } from './tui/probe.ts';
import { loadPreferences, savePreferences } from './preferences.ts';
import { openUrl, copyToClipboard } from './platform.ts';

// Auto-wrap off while the browser owns the screen: a line that came out one
// column too wide is clipped at the edge instead of pushing every row below
// it down by one.
const WRAP_OFF = '\x1b[?7l';
const WRAP_ON = '\x1b[?7h';
const setTitle = (title: string): string => `\x1b]0;${title}\x07`;

export function runBrowse(client: Client): Promise<number> {
  const { stdin, stdout } = process;

  return new Promise<number>((resolve) => {
    let live = true;

    const restoreScreen = (): void => {
      if (!live) return;
      live = false;
      // Hand the tab title back before leaving the alt screen.
      stdout.write(setTitle('') + WHEEL_OFF + WRAP_ON + ALT_SCREEN_OFF);
    };

    const term: Terminal = {
      cols: () => stdout.columns || 80,
      rows: () => stdout.rows || 24,
      paint(frame) {
        if (!live) return;
        // Each row ends by clearing to the end of its line rather than the
        // screen being cleared first, so a repaint never flashes blank.
        stdout.write(SYNC_ON + HOME + frame.map((l) => l + CLEAR_LINE).join('\r\n') + CLEAR_BELOW + SYNC_OFF);
      },
      open: openUrl,
      copy: copyToClipboard,
      now: () => new Date(),
      remember: (view) => savePreferences({ ...loadPreferences(), view }),
      quit(code) {
        teardown();
        resolve(code);
      },
    };

    const app = createApp(client, term, { view: loadPreferences().view });
    const onKey = (chunk: Buffer): void => app.input(chunk.toString('utf8'));
    const onResize = (): void => app.resize();
    const onSignal = (): void => term.quit(0);

    function teardown(): void {
      app.stop();
      stdin.off('data', onKey);
      stdout.off('resize', onResize);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      process.off('exit', restoreScreen);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      restoreScreen();
    }

    stdout.write(ALT_SCREEN_ON + WRAP_OFF + WHEEL_ON + setTitle('Quick Reads'));
    stdin.setRawMode(true);
    stdin.resume();
    process.on('SIGTERM', onSignal);
    process.on('SIGHUP', onSignal);
    // Whatever kills the process, the shell must not be left on the alternate
    // screen with its cursor hidden.
    process.on('exit', restoreScreen);

    // The first frame waits for the terminal to say what color it is, so the
    // screen is drawn once in the right inks rather than twice.
    void probeBackground(stdin, stdout).then(({ rgb, typed }) => {
      if (!live) return;
      setBackground(rgb);
      stdin.on('data', onKey);
      stdout.on('resize', onResize);
      app.start();
      if (typed !== '') app.input(typed);
    });
  });
}
