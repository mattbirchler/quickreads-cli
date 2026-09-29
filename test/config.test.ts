import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set before anything reads it: these tests must never see or touch the
// developer's real Keychain entry.
process.env['QUICKREADS_NO_KEYCHAIN'] = '1';

import { normalizeServerUrl, loadConfig, saveConfig, getToken, storeToken, forgetToken, configPath } from '../src/config.ts';

function withTempHome<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'quickreads-test-'));
  const prevHome = process.env['QUICKREADS_HOME'];
  const prevToken = process.env['QUICKREADS_TOKEN'];
  process.env['QUICKREADS_HOME'] = dir;
  delete process.env['QUICKREADS_TOKEN'];
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env['QUICKREADS_HOME'];
    else process.env['QUICKREADS_HOME'] = prevHome;
    if (prevToken !== undefined) process.env['QUICKREADS_TOKEN'] = prevToken;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('normalizeServerUrl accepts what a person would paste', () => {
  assert.equal(normalizeServerUrl('quickreads.app'), 'https://quickreads.app');
  assert.equal(normalizeServerUrl('https://quickreads.app/'), 'https://quickreads.app');
  assert.equal(normalizeServerUrl('https://quickreads.app/app/settings/developer'), 'https://quickreads.app');
  assert.equal(normalizeServerUrl('http://localhost:3000/app'), 'http://localhost:3000');
  assert.equal(normalizeServerUrl('  quickreads.app  '), 'https://quickreads.app');
});

test('normalizeServerUrl rejects non-URLs', () => {
  assert.throws(() => normalizeServerUrl(''));
  assert.throws(() => normalizeServerUrl('   '));
  assert.throws(() => normalizeServerUrl('not a url'));
});

test('config round-trips and the file is private', () => {
  withTempHome(() => {
    assert.equal(loadConfig(), null);
    saveConfig({ serverUrl: 'https://quickreads.app', token: 'rl_test' });
    assert.deepEqual(loadConfig(), { serverUrl: 'https://quickreads.app', token: 'rl_test' });
    assert.equal(statSync(configPath()).mode & 0o777, 0o600);
  });
});

test('a corrupt config file reads as absent, not as a crash', () => {
  withTempHome(() => {
    saveConfig({ serverUrl: 'https://quickreads.app' });
    writeFileSync(configPath(), 'not json');
    assert.equal(loadConfig(), null);
  });
});

test('QUICKREADS_TOKEN wins over everything', () => {
  withTempHome(() => {
    process.env['QUICKREADS_TOKEN'] = 'rl_env';
    try {
      assert.equal(getToken({ serverUrl: 'x', token: 'rl_file' }), 'rl_env');
    } finally {
      delete process.env['QUICKREADS_TOKEN'];
    }
  });
});

test('without a secret store the key lands in the config file', () => {
  withTempHome(() => {
    assert.equal(storeToken({ serverUrl: 'https://quickreads.app' }, 'rl_file'), 'file');
    assert.equal(getToken(loadConfig()), 'rl_file');
    assert.equal(getToken(null), null);
  });
});

test('logout leaves nothing behind', () => {
  withTempHome(() => {
    storeToken({ serverUrl: 'https://quickreads.app' }, 'rl_file');
    forgetToken();
    assert.equal(existsSync(configPath()), false);
    assert.equal(getToken(loadConfig()), null);
    // Signing out twice is not an error.
    forgetToken();
  });
});
