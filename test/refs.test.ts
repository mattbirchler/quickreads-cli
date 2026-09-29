import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveRef, fileRefs } from '../src/refs.ts';

const REFS = [{ id: 'aaa-111', title: 'First' }, { id: 'bbb-222', title: 'Second' }];

test('a number is a row of the last listing', () => {
  assert.deepEqual(resolveRef('2', REFS), { ok: true, ref: REFS[1] });
  assert.deepEqual(resolveRef(' 1 ', REFS), { ok: true, ref: REFS[0] });
});

test('a number with nothing to refer to explains itself', () => {
  assert.equal(resolveRef('1', null).ok, false);
  assert.equal(resolveRef('1', []).ok, false);
  assert.equal(resolveRef('3', REFS).ok, false);
  assert.equal(resolveRef('0', REFS).ok, false);
  assert.equal(resolveRef('', REFS).ok, false);
});

test('an id passes through, picking up its title when it is known', () => {
  assert.deepEqual(resolveRef('bbb-222', REFS), { ok: true, ref: REFS[1] });
  assert.deepEqual(resolveRef('zzz-999', REFS), { ok: true, ref: { id: 'zzz-999', title: '' } });
  assert.deepEqual(resolveRef('zzz-999', null), { ok: true, ref: { id: 'zzz-999', title: '' } });
});

test('an id made of digits is long enough not to be mistaken for a row', () => {
  assert.deepEqual(resolveRef('12345', REFS), { ok: true, ref: { id: '12345', title: '' } });
});

test('a Quick Reads link is its article', () => {
  assert.deepEqual(resolveRef('https://quickreads.app/app/read/aaa-111?x=1', REFS), { ok: true, ref: REFS[0] });
});

test('the listing survives on disk, privately, and tolerates damage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quickreads-refs-'));
  const prev = process.env['QUICKREADS_HOME'];
  process.env['QUICKREADS_HOME'] = dir;
  try {
    assert.equal(fileRefs.load(), null);
    fileRefs.save(REFS);
    assert.deepEqual(fileRefs.load(), REFS);
    assert.equal(statSync(join(dir, 'last-listing.json')).mode & 0o777, 0o600);
    writeFileSync(join(dir, 'last-listing.json'), '{"not":"a list"}');
    assert.equal(fileRefs.load(), null);
    writeFileSync(join(dir, 'last-listing.json'), 'garbage');
    assert.equal(fileRefs.load(), null);
  } finally {
    if (prev === undefined) delete process.env['QUICKREADS_HOME'];
    else process.env['QUICKREADS_HOME'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
