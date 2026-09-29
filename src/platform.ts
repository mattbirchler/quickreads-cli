// The only module allowed to care what OS this is. Everything OS-specific in
// the CLI (secret storage, opening a browser, setting the clipboard) funnels
// through here so the rest of the codebase never checks process.platform.
import { execFileSync, execFile } from 'node:child_process';

const KEYCHAIN_ACCOUNT = 'quickreads';
const KEYCHAIN_SERVICE = 'quickreads-cli';

// QUICKREADS_NO_KEYCHAIN opts a Mac out of the Keychain: a headless box over
// SSH cannot answer its unlock prompt, and a test run must never read or
// write the developer's real credential.
const hasSecretStore = (): boolean =>
  process.platform === 'darwin' && !process.env['QUICKREADS_NO_KEYCHAIN'];

/**
 * Read the API key from the platform secret store. macOS gets the Keychain.
 * Linux gets null on purpose: libsecret is not universally installed and fails
 * on headless machines, so the baseline there is the 0600 config file (see
 * config.storeToken).
 */
export function getSecret(): string | null {
  if (!hasSecretStore()) return null;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const token = out.trim();
    return token === '' ? null : token;
  } catch {
    // A non-zero exit means the item is not in the Keychain.
    return null;
  }
}

/** Store the key if this platform has a secret store; false means "put it somewhere else". */
export function setSecret(token: string): boolean {
  if (!hasSecretStore()) return false;
  try {
    // execFile rather than exec: the key never passes through a shell.
    execFileSync(
      'security',
      ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', token, '-U'],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/** Forget the stored key. True when something was there to remove. */
export function deleteSecret(): boolean {
  if (!hasSecretStore()) return false;
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

/** Hand a URL to the system browser. Fire-and-forget: nothing should block on it. */
export function openUrl(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(opener, [url], () => {
    // A missing opener is not worth crashing over; the copy key exists for
    // exactly this machine.
  });
}

/**
 * Set the clipboard. First choice is OSC 52: an escape sequence that asks the
 * terminal emulator itself to do it, which is OS-independent and works over SSH
 * and inside tmux. It is write-only fire-and-forget, so the binary fallbacks run
 * unconditionally after it; a terminal that ignored the sequence still gets the
 * text, and one that honored it just sets the same value twice.
 */
export function copyToClipboard(text: string): boolean {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  if (process.stdout.isTTY) process.stdout.write(`\x1b]52;c;${b64}\x07`);

  const candidates: [string, string[]][] = process.platform === 'darwin'
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of candidates) {
    try {
      execFileSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {
      // Not installed or not talking to this display; try the next one.
    }
  }
  // OSC 52 may well have worked, but we cannot know, so only claim success when
  // a binary confirmed it.
  return false;
}
