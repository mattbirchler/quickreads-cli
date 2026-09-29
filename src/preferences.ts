// What the reader chose, kept apart from their credentials so that changing
// one can never damage the other.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.ts';
import type { View } from './tui/state.ts';

export interface Preferences {
  view: View;
}

const DEFAULTS: Preferences = { view: 'roomy' };

const preferencesPath = (): string => join(configDir(), 'preferences.json');

export function loadPreferences(): Preferences {
  try {
    const parsed = JSON.parse(readFileSync(preferencesPath(), 'utf8')) as Record<string, unknown>;
    return { view: parsed['view'] === 'compact' ? 'compact' : 'roomy' };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(preferences: Preferences): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(preferencesPath(), `${JSON.stringify(preferences, null, 2)}\n`);
  } catch {
    // A preference that cannot be saved is still in effect until they quit.
  }
}
