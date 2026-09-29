#!/usr/bin/env node
import { main } from '../src/cli.ts';

// `quickreads list | head -3` closes the pipe while there are rows left to
// write. That is the reader having seen enough, not a failure.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
