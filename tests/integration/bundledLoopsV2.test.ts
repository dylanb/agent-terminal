import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
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
      const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE }, repoDir });
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (!r.ok) return;
      expect(r.def.origin).toBe('app-bundled');
      expect(r.def.gate.length).toBeGreaterThan(0);
    });

    it(`${name}: every catalog persona resolves to a charter document that exists`, () => {
      const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE }, repoDir });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const reviewer of r.def.reviewers) {
        expect(existsSync(reviewer.charter), `${name} charter for ${reviewer.persona}: ${reviewer.charter}`).toBe(true);
      }
    });
  }

  it('groom-loop and plan-loop declare different gate options (differing defs, AC 1)', () => {
    const g = resolveLoopDefV2('groom-loop', { tiers: { operator: null, appBundled: SOURCE_TREE }, repoDir });
    const p = resolveLoopDefV2('plan-loop', { tiers: { operator: null, appBundled: SOURCE_TREE }, repoDir });
    expect(g.ok && p.ok).toBe(true);
    if (!g.ok || !p.ok) return;
    expect(g.def.gate.map((x) => x.option)).not.toEqual(p.def.gate.map((x) => x.option));
  });
});
