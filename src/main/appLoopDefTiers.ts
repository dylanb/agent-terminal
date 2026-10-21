import type { BundleLocation } from './bundleLocation';
import type { LoopDefV2Tiers } from './loopDefV2';
import { resolveExampleLoopsV2Dir } from './exampleAssets';
import { userConfigLoopsDir, userConfigLoopsV2Dir } from './userConfig';

/** The §27 def-resolution tiers the composition root hands `resolveLoopDefV2` (§27.15). The surviving operator
 *  tier and the retired-schema tier are each derived from their OWN user-config resolver — never a sibling path
 *  literal — so a CLAUDE_CONFIG_DIR redirect can never move one without the other, and the retired leg feeds
 *  AC 5's no-tier-answers reason enrichment (a def name absent from every surviving tier, with the operator's
 *  own retired-schema def still present, names why it stopped resolving). */
export function resolveAppLoopDefTiers(iconLoc: BundleLocation, configRoot: string | null): LoopDefV2Tiers {
  return {
    operator: configRoot === null ? null : userConfigLoopsV2Dir(configRoot),
    appBundled: resolveExampleLoopsV2Dir(iconLoc),
    retired: configRoot === null ? null : userConfigLoopsDir(configRoot),
  };
}
