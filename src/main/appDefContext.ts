// §27.15 — the one def-resolution context the app, the bench runner's refusals and its prompt revision (#180)
// resolve loop defs through, so all three read the same def from the same tiers.

import type { BundleLocation } from './bundleLocation';
import type { LoopDefV2Context } from './loopDefV2';
import { resolveAppLoopDefTiers } from './appLoopDefTiers';

/** `flow` is the running flow's name; `configRoot` the user-config root, none when null. */
export function appDefContext(bundle: BundleLocation, configRoot: string | null, repoDir: string, flow?: string): LoopDefV2Context {
  return {
    tiers: resolveAppLoopDefTiers(bundle, configRoot),
    repoDir,
    ...(flow !== undefined ? { flow } : {}),
  };
}
