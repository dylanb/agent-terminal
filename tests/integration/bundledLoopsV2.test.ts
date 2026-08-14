import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { catalogPersonas } from '../../src/main/reviewTurn';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

// The bundled §27 (v2) def tree is the app-bundled resolution tier for `app`-namespace flow steps. The
// tracer bullet (AC 1) rests on all three defs resolving from it and declaring gate options; each catalog
// persona must resolve to a charter document that actually exists (the only check on the reference graph
// before N4 consumes it). Uses the in-tree SOURCE tree as the app tier — the same bytes the build step
// places at the runtime-resolved destination.

const SOURCE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const repoDir = resolve(__dirname, '..', '..');

describe('bundled §27 loop-def tree (AC 1 / §27.15)', () => {
  for (const name of ['groom-loop', 'plan-loop', 'impl-loop']) {
    it(`resolves ${name} from the app-bundled tier with declared gate options`, () => {
      const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir });
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (!r.ok) return;
      expect(r.tierRoot).toBe(SOURCE_TREE);
      expect(r.def.gate.length).toBeGreaterThan(0);
    });

    it(`${name}: every catalog persona resolves to a charter document that exists`, () => {
      const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const reviewer of r.def.reviewers) {
        expect(existsSync(reviewer.charter), `${name} charter for ${reviewer.persona}: ${reviewer.charter}`).toBe(true);
      }
    });
  }

  // Each phase's reviewer catalog must reach v1 persona parity: the same review DIMENSIONS the v1 flow
  // covered (~/.claude/loops/*), re-expressed as v2 charters. Membership only — the catalog may hold more,
  // and round rosters are the consolidator's job — but every v1 dimension must have a standing charter to
  // draw on, or the loop silently reviews a narrower surface than the v1 flow it replaces.
  const PARITY: Record<string, string[]> = {
    'impl-loop': [
      'impl-review-principal',
      'impl-review-tests',
      'impl-review-security',
      'impl-review-taint',
      'impl-review-reliability',
      'impl-review-architecture',
      'impl-review-contracts',
      'impl-review-intent',
      'impl-review-maintainability',
      'impl-review-conventions',
      'impl-review-accessibility',
      'impl-review-diagrams',
    ],
    'plan-loop': [
      'review-plan-principal',
      'review-plan-security',
      'review-plan-architecture',
      'review-plan-intent',
      'review-plan-maintainability',
      'review-plan-contracts',
    ],
  };
  for (const [name, expected] of Object.entries(PARITY)) {
    it(`${name}: catalog reaches v1 persona parity (${expected.length} personas)`, () => {
      const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir });
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (!r.ok) return;
      const personas = catalogPersonas(r.def);
      const missing = expected.filter((p) => !personas.includes(p));
      expect(missing, `${name} missing personas: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('groom-loop and plan-loop declare different approve side-effects (differing defs, AC 1 / §27.13)', () => {
    // Post-N5 the shipped defs are all approve-only, so they differ by their §27.13 approve SIDE-EFFECT
    // (groom → update-issue-body, plan → PR non-draft flip), not by their option list.
    const g = resolveLoopDefV2('groom-loop', { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir });
    const p = resolveLoopDefV2('plan-loop', { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir });
    expect(g.ok && p.ok).toBe(true);
    if (!g.ok || !p.ok) return;
    const actions = (r: typeof g): unknown[] => (r.ok ? r.def.gate.flatMap((x) => x.sideEffects.map((se) => se.args.action)) : []);
    expect(actions(g)).not.toEqual(actions(p));
  });
});
