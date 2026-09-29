import { readFileSync } from 'node:fs';
import { DEFAULT_SERVER, loadConfig, getToken, storeToken, forgetToken, normalizeServerUrl, configPath } from './config.ts';
import { createClient, verifyToken, ApiError } from './api.ts';
import { explain } from './explain.ts';

const HELP = `quickreads: Quick Reads in your terminal

Usage:
  quickreads                         Browse your queue interactively
  quickreads list                    Print your reading queue
  quickreads read <article>          Read an article
  quickreads save <url>...           Save to your queue
  quickreads search <words>          Search everything you have saved
  quickreads highlights [<article>]  Your highlights, newest first
  quickreads archive <article>       Archive an article
  quickreads unarchive <article>     Return an article to the queue
  quickreads open <article>          Open an article in your browser
  quickreads tags                    List your tags
  quickreads whoami                  Show the connected account
  quickreads auth                    Connect an account with an API key
  quickreads logout                  Forget the stored API key
  quickreads help                    Show this help
  quickreads version                 Show the version

<article> is a row number from the last list, search, or highlights output,
or an article id.

List options:
  --archived         The archive instead of the queue
  --todo             Your To Do list instead of the queue
  --limit <n>        How many to print (default: 25)

Read options:
  --no-pager         Print the article instead of paging it
  --width <n>        Wrap to this many columns (default: 80 at most)

Save options:
  --todo             Save to your To Do list instead of the queue
  --title <title>    A title of your own (To Do items and --text)
  --text             Save text or markdown from standard input

Search options:
  --tag <name>       Only articles with this tag (works without words too)
  --limit <n>        How many to print (default: 25)

Output options (list, search, highlights, tags, read, save):
  --json             JSON, one object per line
  --plain            Tab-separated, one item per line

Auth options:
  --server <url>     Quick Reads server (default: ${DEFAULT_SERVER})
  --token <key>      Provide the API key non-interactively

Create an API key in Quick Reads under Settings, Developer, then run
\`quickreads auth\`. The key is stored in the macOS Keychain, or in
${'~'}/.config/quickreads/config.json (mode 0600) on platforms without one.
QUICKREADS_TOKEN overrides both.
`;

export interface Flags {
  json: boolean;
  plain: boolean;
  archived: boolean;
  todo: boolean;
  text: boolean;
  noPager: boolean;
  limit: number | null;
  width: number | null;
  tag: string | null;
  title: string | null;
  server: string | null;
  token: string | null;
}

export interface Parsed {
  command: string;
  // Positional arguments after the command.
  args: string[];
  flags: Flags;
  error: string | null;
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Flags = {
    json: false, plain: false, archived: false, todo: false, text: false, noPager: false,
    limit: null, width: null, tag: null, title: null, server: null, token: null,
  };
  const args: string[] = [];
  let command: string | null = null;
  let error: string | null = null;
  let flagsDone = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takesValue = (name: string): string | null => {
      const value = argv[++i];
      if (value === undefined) { error = `${name} needs a value.`; return null; }
      return value;
    };
    const takesNumber = (name: string): number | null => {
      const value = takesValue(name);
      if (value === null) return null;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) { error = `${name} needs a whole number above zero.`; return null; }
      return n;
    };

    if (flagsDone || !arg.startsWith('-') || arg === '-') {
      if (command === null) command = arg;
      else args.push(arg);
    } else if (arg === '--') flagsDone = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--plain') flags.plain = true;
    else if (arg === '--archived' || arg === '--archive') flags.archived = true;
    else if (arg === '--todo') flags.todo = true;
    else if (arg === '--text') flags.text = true;
    else if (arg === '--no-pager') flags.noPager = true;
    else if (arg === '--limit' || arg === '-n') flags.limit = takesNumber(arg);
    else if (arg === '--width') flags.width = takesNumber(arg);
    else if (arg === '--tag') flags.tag = takesValue(arg);
    else if (arg === '--title') flags.title = takesValue(arg);
    else if (arg === '--server') flags.server = takesValue(arg);
    else if (arg === '--token') flags.token = takesValue(arg);
    else if (arg === '--help' || arg === '-h') command = 'help';
    else if (arg === '--version' || arg === '-v') command = command ?? 'version';
    else error = `Unknown option: ${arg}`;
  }

  if (flags.json && flags.plain) error = 'Choose one of --json and --plain.';
  return { command: command ?? 'browse', args, flags, error };
}

/**
 * Read a secret from the terminal without echoing it. A piped stdin just reads
 * the line, which is what scripts want.
 */
async function promptHidden(question: string): Promise<string> {
  process.stderr.write(question);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0]!.trim();
  }
  stdin.setRawMode(true);
  stdin.resume();
  let entered = '';
  const value = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03) { // Ctrl-C during a prompt is still Ctrl-C.
          process.stderr.write('\n');
          process.exit(130);
        }
        if (byte === 0x0d || byte === 0x0a) {
          stdin.off('data', onData);
          resolve(entered);
          return;
        }
        if (byte === 0x7f || byte === 0x08) entered = entered.slice(0, -1);
        else entered += String.fromCharCode(byte);
      }
    };
    stdin.on('data', onData);
  });
  stdin.setRawMode(false);
  stdin.pause();
  process.stderr.write('\n');
  return value.trim();
}

async function runAuth(flags: Flags): Promise<number> {
  const existing = loadConfig();
  const serverUrl = normalizeServerUrl(flags.server ?? existing?.serverUrl ?? DEFAULT_SERVER);

  let token = flags.token?.trim() ?? '';
  if (token === '') {
    process.stderr.write(`Connecting to ${serverUrl}\n`);
    process.stderr.write(`Create an API key at ${serverUrl}/app/settings/developer, then paste it here.\n`);
    token = await promptHidden('API key (rl_...): ');
  }
  if (token === '') {
    process.stderr.write('No key entered.\n');
    return 1;
  }

  let email: string;
  let tier: string;
  try {
    ({ email, tier } = await verifyToken(serverUrl, token));
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'unauthorized') {
      process.stderr.write('That key was rejected. Check it in Quick Reads Settings and try again.\n');
    } else {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }

  const config = { ...(existing ?? {}), serverUrl };
  const where = storeToken(config, token);
  process.stderr.write(`Connected as ${email}.\n`);
  process.stderr.write(
    where === 'keychain'
      ? 'Key stored in the macOS Keychain.\n'
      : `Key stored in ${configPath()} (readable only by you).\n`,
  );
  // The API answers /api/me for an account with no subscription, but nothing
  // else will work for it; better to hear that now than on the first list.
  if (tier === 'free') {
    process.stderr.write('This account has no active subscription, so the queue will not load until it does.\n');
  }
  return 0;
}

export interface Connection {
  serverUrl: string;
  token: string;
}

/** The stored account, or null after telling the person how to connect one. */
export function connect(flags: Flags): Connection | null {
  const config = loadConfig();
  // --server outside of `auth` is an override for this run, not a
  // reconfiguration; auth is what changes the stored server.
  const serverUrl = normalizeServerUrl(flags.server ?? config?.serverUrl ?? DEFAULT_SERVER);
  const token = flags.token ?? getToken(config);
  if (token === null) {
    process.stderr.write('No account connected. Run `quickreads auth` first.\n');
    return null;
  }
  return { serverUrl, token };
}

export async function main(argv: string[]): Promise<number> {
  const { command, args, flags, error } = parseArgs(argv);
  if (error !== null) {
    process.stderr.write(`${error}\nRun \`quickreads help\` for usage.\n`);
    return 2;
  }

  switch (command) {
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'version': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    case 'auth':
    case 'login':
      return runAuth(flags);
    case 'logout':
      forgetToken();
      process.stderr.write('Signed out. The API key is gone from this machine; revoke it in Quick Reads Settings to retire it everywhere.\n');
      return 0;
    default: {
      const { COMMANDS } = await import('./commands.ts');
      // The browser needs a terminal on both ends. In a pipe the bare command
      // is the list, which is what `quickreads | head` was asking for.
      const interactive = command === 'browse' && process.stdout.isTTY === true && process.stdin.isTTY === true;
      const run = COMMANDS[command === 'browse' ? 'list' : command];
      if (run === undefined) {
        process.stderr.write(`Unknown command: ${command}\nRun \`quickreads help\` for usage.\n`);
        return 2;
      }
      const connection = connect(flags);
      if (connection === null) return 1;
      const { terminalIo } = await import('./io.ts');
      try {
        if (interactive) {
          const { runBrowse } = await import('./browse.ts');
          return await runBrowse(createClient(connection.serverUrl, connection.token));
        }
        return await run({
          client: createClient(connection.serverUrl, connection.token),
          io: terminalIo(),
          flags,
          args,
        });
      } catch (err) {
        process.stderr.write(`${explain(err)}\n`);
        return 1;
      }
    }
  }
}
