import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { catalogPersonas } from '../../src/main/reviewTurn';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { bundledLoopDir, resolveBundledLoop } from '../helpers/bundledLoops';

// The bundled §27 (v2) def tree is the app-bundled resolution tier for `app`-namespace flow steps. The
// tracer bullet (AC 1) rests on all three defs resolving from it and declaring gate options; each catalog
// persona must resolve to a charter document that actually exists (the only check on the reference graph
// before N4 consumes it). Uses the in-tree SOURCE tree as the app tier — the same bytes the build step
// places at the runtime-resolved destination.

const SOURCE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const repoDir = resolve(__dirname, '..', '..');

describe('bundled §27 loop-def tree (AC 1 / §27.15)', () => {
  for (const name of ['groom-loop', 'plan-loop', 'integration-slice-loop']) {
    it(`resolves ${name} from the app-bundled tier with declared gate options`, () => {
      const r = resolveBundledLoop(name);
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (!r.ok) return;
      expect(r.tierRoot).toBe(SOURCE_TREE);
      expect(r.def.gate.length).toBeGreaterThan(0);
    });

    it(`${name}: every catalog persona resolves to a charter document that exists`, () => {
      const r = resolveBundledLoop(name);
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
    'integration-slice-loop': [
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
      const r = resolveBundledLoop(name);
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (!r.ok) return;
      const personas = catalogPersonas(r.def);
      const missing = expected.filter((p) => !personas.includes(p));
      expect(missing, `${name} missing personas: ${missing.join(', ')}`).toEqual([]);
    });
  }

  // A lens whose subject the change lacks costs a full review for nothing, and green's catalog runs it every
  // round 1 (§27.4). Each scoped lens's canonical charter tells the reviewer to return clean when its subject
  // is absent; the per-loop byte-copies are pinned to these sources by s7ChainWiring.
  for (const lane of ['accessibility', 'security', 'taint']) {
    it(`integration-slice-loop ${lane} charter returns clean when the change lacks its subject`, () => {
      const body = readFileSync(join(bundledLoopDir('integration-slice-loop'), 'charter', `${lane}.md`), 'utf8');
      expect(body.toLowerCase()).toMatch(/return clean/);
    });
  }

  it('groom-loop and plan-loop declare different approve side-effects (differing defs, AC 1 / §27.13)', () => {
    // Post-N5 the shipped defs are all approve-only, so they differ by their §27.13 approve SIDE-EFFECT
    // (groom → update-issue-body, plan → PR non-draft flip), not by their option list.
    const g = resolveBundledLoop('groom-loop');
    const p = resolveBundledLoop('plan-loop');
    expect(g.ok && p.ok).toBe(true);
    if (!g.ok || !p.ok) return;
    const actions = (r: typeof g): unknown[] => (r.ok ? r.def.gate.flatMap((x) => x.sideEffects.map((se) => se.args.action)) : []);
    expect(actions(g)).not.toEqual(actions(p));
  });
});

// §27.8 — every bundled loop def lives in the folder of the shipped flow that binds it, so one flow's loops
// can change without changing another's, and an install never writes the shared operator folder.
describe('bundled loop defs are grouped by the shipped flow that binds them', () => {
  const FLOWS_TREE = resolveExampleFlowsDir({ packaged: false, appPath: repoDir });
  const flowIds = (): string[] => readdirSync(FLOWS_TREE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const boundLoops = (flow: string): string[] => {
    const doc = yaml.load(readFileSync(join(FLOWS_TREE, flow, 'flow.yaml'), 'utf8')) as { steps: { loop?: string }[] };
    return doc.steps.flatMap((s) => (typeof s.loop === 'string' ? [s.loop] : []));
  };

  it('holds one folder per shipped flow and nothing else at its top level', () => {
    const top = readdirSync(SOURCE_TREE, { withFileTypes: true }).map((e) => e.name).sort();
    expect(top).toEqual(flowIds());
  });

  it('holds exactly the loops each shipped flow binds, each resolving from that flow’s folder', () => {
    for (const flow of flowIds()) {
      const loops = [...new Set(boundLoops(flow))].sort();
      expect(readdirSync(join(SOURCE_TREE, flow)).sort(), flow).toEqual(loops);
      for (const name of loops) {
        const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir, flow });
        expect(r.ok, `${flow}/${name}: ${r.ok ? '' : r.reason}`).toBe(true);
        if (r.ok) expect(r.def.work.recipe.startsWith(join(SOURCE_TREE, flow, name) + sep), `${flow}/${name}`).toBe(true);
      }
    }
  });
});
