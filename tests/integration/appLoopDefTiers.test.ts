import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppLoopDefTiers } from '../../src/main/appLoopDefTiers';
import type { BundleLocation } from '../../src/main/bundleLocation';

// The composition root hands `resolveLoopDefV2` its def tiers through this one helper (index.ts). The wiring
// contract AC 5 depends on: the SURVIVING operator tier AND the RETIRED-schema tier are each derived from their
// OWN user-config resolver, so a CLAUDE_CONFIG_DIR redirect moves both together and the retired leg is present
// for the no-tier-answers reason enrichment. A `retired: null` mis-wire — the pre-fix state, where nothing in
// production reached `userConfigLoopsDir` — fails the retired assertion here.
describe('resolveAppLoopDefTiers — the composition root wires all three def tiers (§27.15, AC 5)', () => {
  let prevConfigDir: string | undefined;
  let configDir: string;
  let appDir: string;

  beforeEach(() => {
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    configDir = mkdtempSync(join(tmpdir(), 'tiers-cfg-'));
    appDir = mkdtempSync(join(tmpdir(), 'tiers-app-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    for (const d of [configDir, appDir]) rmSync(d, { recursive: true, force: true });
  });

  it('derives the retired-schema tier from userConfigLoopsDir — a sibling of the surviving loops-v2 tier', () => {
    const loc: BundleLocation = { packaged: false, appPath: appDir };
    const tiers = resolveAppLoopDefTiers(loc, configDir);
    expect(tiers.retired).toBe(join(configDir, 'loops'));
    expect(tiers.operator).toBe(join(configDir, 'loops-v2'));
    // the two operator-space tiers are disjoint siblings, never nested
    expect(tiers.retired).not.toBe(tiers.operator);
  });

  it('carries a non-null app-bundled root so a namespace-less step always has a fallback tier', () => {
    const loc: BundleLocation = { packaged: false, appPath: appDir };
    const tiers = resolveAppLoopDefTiers(loc, configDir);
    expect(typeof tiers.appBundled).toBe('string');
    expect(tiers.appBundled.length).toBeGreaterThan(0);
  });
});
