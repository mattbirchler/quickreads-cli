import { ApiError } from './api.ts';

/** An error as a sentence, with the way out when there is one. */
export function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === 'unauthorized') return 'The server rejected this API key. Run `quickreads auth` to connect again.';
    if (err.kind === 'not_found') {
      return `${err.message.replace(/\.$/, '')}. It may have been deleted; \`quickreads list\` shows what is there now.`;
    }
    if (err.kind === 'rate_limited') return 'Quick Reads is asking for a breather. Wait a moment and try again.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
