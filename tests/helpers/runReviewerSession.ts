import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentsDir } from '../../src/main/runReviewers';

const LOADED_AT = new Date(0);

/** Makes the reviewers installed in `runFolder` count as loaded by an agent session, whether that session is a
 *  real one started after this call or one a test injects with the returned start time. Reviewers written
 *  after this call still count as unloaded. This is the one place tests encode how loading is detected. */
export function markRunReviewersLoaded(runFolder: string): number {
  const dir = runAgentsDir(runFolder).dir;
  if (existsSync(dir)) for (const file of readdirSync(dir)) utimesSync(join(dir, file), LOADED_AT, LOADED_AT);
  return LOADED_AT.getTime() + 1;
}
