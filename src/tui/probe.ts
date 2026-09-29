// Asking the terminal what color is behind the text. The answer lets the
// selection be a tint of the reader's own background instead of a slab of
// reverse video, and picks inks that read on a light theme.
import type { Rgb } from '../ansi.ts';

// OSC 11 asks for the background. The device attributes request after it is
// the trick that makes this safe to ask of any terminal: every terminal
// answers that one, and answers in order, so its reply arriving first means
// the color question was not understood and there is nothing to wait for.
export const QUERY = '\x1b]11;?\x07\x1b[c';

// eslint-disable-next-line no-control-regex
const COLOR_REPLY = /\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
const ATTRIBUTES_REPLY = /\x1b\[\?[0-9;]*c/;

// Each channel arrives as one to four hex digits, scaled to its own width.
const channel = (hex: string): number =>
  Math.round((Number.parseInt(hex, 16) / (16 ** hex.length - 1)) * 255);

export interface Probe {
  // The background, once the terminal has said.
  rgb: Rgb | null;
  // True once the terminal has finished answering, with or without a color.
  done: boolean;
  // Whatever else arrived: keys typed before the first frame, to be handled
  // as input rather than dropped.
  rest: string;
}

/** Read what has arrived so far in reply to QUERY. */
export function readProbe(received: string): Probe {
  let rest = received;
  let rgb: Rgb | null = null;
  const color = COLOR_REPLY.exec(rest);
  if (color !== null) {
    rgb = [channel(color[1]!), channel(color[2]!), channel(color[3]!)];
    rest = rest.slice(0, color.index) + rest.slice(color.index + color[0].length);
  }
  const attributes = ATTRIBUTES_REPLY.exec(rest);
  if (attributes !== null) {
    rest = rest.slice(0, attributes.index) + rest.slice(attributes.index + attributes[0].length);
  }
  return { rgb, done: attributes !== null, rest };
}

/** What QUICKREADS_THEME or COLORFGBG says, for terminals that cannot be asked. */
export function backgroundFromEnv(env: NodeJS.ProcessEnv): Rgb | null {
  const forced = env['QUICKREADS_THEME']?.trim().toLowerCase();
  if (forced === 'dark') return [24, 24, 27];
  if (forced === 'light') return [255, 255, 255];
  // "15;0": foreground;background as palette indexes. 0 to 6 and 8 are dark.
  const last = env['COLORFGBG']?.split(';').pop();
  if (last !== undefined && /^\d+$/.test(last)) {
    const index = Number(last);
    return index <= 6 || index === 8 ? [24, 24, 27] : [255, 255, 255];
  }
  return null;
}

// Long enough for a terminal at the far end of an SSH connection, short
// enough that a terminal which never answers costs nothing noticeable.
const TIMEOUT_MS = 250;

/**
 * Ask the terminal for its background. Resolves with the color (or null) and
 * any keys that were typed while waiting. stdin must already be in raw mode.
 */
export function probeBackground(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ rgb: Rgb | null; typed: string }> {
  const forced = env['QUICKREADS_THEME']?.trim().toLowerCase();
  if (forced === 'dark' || forced === 'light') {
    return Promise.resolve({ rgb: backgroundFromEnv(env), typed: '' });
  }
  return new Promise((resolve) => {
    let received = '';
    const finish = (): void => {
      clearTimeout(timer);
      stdin.off('data', onData);
      const { rgb, rest } = readProbe(received);
      resolve({ rgb: rgb ?? backgroundFromEnv(env), typed: rest });
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.toString('utf8');
      if (readProbe(received).done) finish();
    };
    const timer = setTimeout(finish, TIMEOUT_MS);
    stdin.on('data', onData);
    stdout.write(QUERY);
  });
}
