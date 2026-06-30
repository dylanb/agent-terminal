// §26.4 / §26.3 D47a(b) — the reviewers turn's artifact-confirmed check: every roster persona has
// written a parseable review JSON for the current iteration. A missing or malformed one leaves the turn
// un-confirmed (the orchestrator retries, then errors) rather than advancing on a partial fan-out.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** True iff every `persona` has a parseable `reviews/{iteration}/{persona}.json` under `<repoDir>/.agent-loop`.
 *  An absent or non-JSON file fails the check; vacuously true for an empty roster (the caller guards that). */
export function allReviewsPresent(repoDir: string, iteration: number, personas: string[]): boolean {
  return personas.every((persona) => {
    const file = path.join(repoDir, '.agent-loop', 'reviews', String(iteration), `${persona}.json`);
    try {
      JSON.parse(readFileSync(file, 'utf8'));
      return true;
    } catch {
      return false;
    }
  });
}
