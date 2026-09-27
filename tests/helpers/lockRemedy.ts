// Shared by the vitest rows and the Playwright e2e, so it imports neither runner.

import { realpathSync } from 'node:fs';

/** What an unidentified-holder refusal must tell the user (operator decision, #134 impl round 2): the lockfile's
 *  real path, and to delete it and try again. */
export function unidentifiedHolderRemedy(lockFile: string): { path: string; deletes: RegExp; retries: RegExp } {
  return { path: realpathSync(lockFile), deletes: /\bdelete\b/i, retries: /\btry again\b/i };
}
