// §27.15

import type { BundleLocation } from './bundleLocation';
import type { LoopDefV2Context } from './loopDefV2';
import { resolveAppLoopDefTiers } from './appLoopDefTiers';

/** `flow` is the running flow's name. */
export function appDefContext(bundle: BundleLocation, configRoot: string | null, repoDir: string, flow?: string): LoopDefV2Context {
  return {
    tiers: resolveAppLoopDefTiers(bundle, configRoot),
    repoDir,
    ...(flow !== undefined ? { flow } : {}),
  };
}
