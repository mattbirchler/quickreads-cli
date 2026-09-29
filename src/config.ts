import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSecret, setSecret, deleteSecret } from './platform.ts';

export const DEFAULT_SERVER = 'https://quickreads.app';

export interface Config {
  serverUrl: string;
  // Present only when the key could not go somewhere better; see storeToken.
  token?: string;
}

// XDG on every platform, macOS included: the file has to be findable by someone
// reading the docs on either OS, and ~/Library/Application Support is not where
// anyone looks for a CLI's config.
export function configDir(): string {
  if (process.env['QUICKREADS_HOME']) return process.env['QUICKREADS_HOME'];
  const xdg = process.env['XDG_CONFIG_HOME'];
  return join(xdg && xdg !== '' ? xdg : join(homedir(), '.config'), 'quickreads');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

/**
 * Accepts what a person would actually paste: a bare domain, a URL with a
 * trailing slash, or a page they were already looking at. Returning `origin`
 * discards paths and trailing slashes in one move.
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('That does not look like a server URL.');
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error('That does not look like a server URL.');
  }
  if (url.hostname === '' || url.hostname.includes(' ')) {
    throw new Error('That does not look like a server URL.');
  }
  return url.origin;
}

export function loadConfig(): Config | null {
  let text: string;
  try {
    text = readFileSync(configPath(), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed['serverUrl'] === 'string') {
      const config: Config = { serverUrl: parsed['serverUrl'] };
      if (typeof parsed['token'] === 'string') config.token = parsed['token'];
      return config;
    }
  } catch {
    // A corrupt file is recoverable by running `quickreads auth` again.
  }
  return null;
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true });
  // 0600 because the file may hold the key on platforms without a keychain.
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The API key, by preference: environment (tests, CI, one-off overrides),
 * then the platform secret store, then the config file (the platforms where the
 * secret store said no at save time).
 */
export function getToken(config: Config | null): string | null {
  const fromEnv = process.env['QUICKREADS_TOKEN'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromStore = getSecret();
  if (fromStore !== null) return fromStore;
  return config?.token ?? null;
}

/**
 * Puts the key in the platform secret store when there is one, and in the
 * 0600 config file when there is not. Returns where it went so `auth` can say
 * so out loud; a person deciding whether to trust a tool with a credential is
 * owed the answer to "where did you put it".
 */
export function storeToken(config: Config, token: string): 'keychain' | 'file' {
  if (setSecret(token)) {
    // Never leave a stale copy in the file shadowing the store.
    delete config.token;
    saveConfig(config);
    return 'keychain';
  }
  config.token = token;
  saveConfig(config);
  return 'file';
}

/** Remove the key from everywhere this CLI could have put it. */
export function forgetToken(): void {
  deleteSecret();
  rmSync(configPath(), { force: true });
}
