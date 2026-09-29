import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.ts';

test('bare invocation is the interactive browser', () => {
  const { command, args, error } = parseArgs([]);
  assert.equal(command, 'browse');
  assert.deepEqual(args, []);
  assert.equal(error, null);
});

test('a command collects its positionals and flags in any order', () => {
  const { command, args, flags, error } = parseArgs(['search', '--limit', '5', 'apple', 'silicon', '--json']);
  assert.equal(command, 'search');
  assert.deepEqual(args, ['apple', 'silicon']);
  assert.equal(flags.limit, 5);
  assert.equal(flags.json, true);
  assert.equal(error, null);
});

test('list takes --archived, --todo and -n', () => {
  const { flags } = parseArgs(['list', '--archived', '-n', '10']);
  assert.equal(flags.archived, true);
  assert.equal(flags.limit, 10);
  assert.equal(parseArgs(['list', '--todo']).flags.todo, true);
});

test('save takes a title and a list', () => {
  const { command, args, flags } = parseArgs(['save', 'https://example.com/a', '--todo', '--title', 'Buy this']);
  assert.equal(command, 'save');
  assert.deepEqual(args, ['https://example.com/a']);
  assert.equal(flags.todo, true);
  assert.equal(flags.title, 'Buy this');
});

test('auth takes --server and --token', () => {
  const { command, flags } = parseArgs(['auth', '--server', 'localhost:3000', '--token', 'rl_x']);
  assert.equal(command, 'auth');
  assert.equal(flags.server, 'localhost:3000');
  assert.equal(flags.token, 'rl_x');
});

test('-h and --version resolve to commands', () => {
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  // Help wins even after a command, so `quickreads read --help` explains itself.
  assert.equal(parseArgs(['read', '--help']).command, 'help');
});

test('-- ends the options so a query can start with a dash', () => {
  const { command, args, error } = parseArgs(['search', '--', '--weird']);
  assert.equal(command, 'search');
  assert.deepEqual(args, ['--weird']);
  assert.equal(error, null);
});

test('a flag missing its value is an error, not a crash', () => {
  assert.notEqual(parseArgs(['list', '--limit']).error, null);
});

test('a limit has to be a whole number above zero', () => {
  assert.notEqual(parseArgs(['list', '--limit', 'ten']).error, null);
  assert.notEqual(parseArgs(['list', '--limit', '0']).error, null);
  assert.notEqual(parseArgs(['list', '--limit', '2.5']).error, null);
});

test('--json and --plain are one or the other', () => {
  assert.notEqual(parseArgs(['list', '--json', '--plain']).error, null);
});

test('unknown options are refused', () => {
  assert.notEqual(parseArgs(['--nope']).error, null);
});
