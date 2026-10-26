import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import { resolveBundledLoop } from '../helpers/bundledLoops';

const SOURCE_TREE = resolveExampleLoopsV2Dir({ packaged: false, appPath: resolve(__dirname, '..', '..') });
const repoDir = resolve(__dirname, '..', '..');

describe('bundled §27 loop-def tree (AC 1 / §27.15)', () => {
  for (const name of ['groom-loop', 'plan-loop', 'integration-slice-loop']) {
    it(`resolves ${name} from the app-bundled tier`, () => {
      const r = resolveBundledLoop(name);
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (!r.ok) return;
      expect(r.tierRoot).toBe(SOURCE_TREE);
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
});

// §27.8
describe('bundled loop defs are grouped by the shipped flow that binds them', () => {
  const FLOWS_TREE = resolveExampleFlowsDir({ packaged: false, appPath: repoDir });
  const flowIds = (): string[] => readdirSync(FLOWS_TREE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const boundLoops = (flow: string): string[] => {
    const doc = yaml.load(readFileSync(join(FLOWS_TREE, flow, 'flow.yaml'), 'utf8')) as { steps: { loop?: string }[] };
    return doc.steps.flatMap((s) => (typeof s.loop === 'string' ? [s.loop] : []));
  };

  it('resolves every loop each shipped flow binds from that flow’s folder', () => {
    const flows = flowIds();
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      const names = new Set(boundLoops(flow));
      expect(names.size, flow).toBeGreaterThan(0);
      for (const name of names) {
        const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir, flow });
        expect(r.ok, `${flow}/${name}: ${r.ok ? '' : r.reason}`).toBe(true);
        if (r.ok) expect(r.def.work.recipe.startsWith(join(SOURCE_TREE, flow, name) + sep), `${flow}/${name}`).toBe(true);
      }
    }
  });
});
