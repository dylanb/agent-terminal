import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir, resolveExampleStepsDir } from '../../src/main/exampleAssets';
import { loadFlowDefinitionFromFile } from '../../src/main/flow';
import { createStepLibrary } from '../../src/main/stepLibrary';
import { listLoopFolders } from '../../src/main/loopFolders';
import { MOVED_LOOPS } from '../../src/main/retiredExamples';
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
describe('bundled loop defs ship in the folder of the flow that binds them or in the shared folder', () => {
  const FLOWS_TREE = resolveExampleFlowsDir({ packaged: false, appPath: repoDir });
  const flowIds = (): string[] => readdirSync(FLOWS_TREE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const bundledSteps = createStepLibrary([{ name: 'bundled', dir: resolveExampleStepsDir({ packaged: false, appPath: repoDir }) }]);
  const boundLoops = (flow: string): string[] => {
    const load = loadFlowDefinitionFromFile(join(FLOWS_TREE, flow, 'flow.yaml'), bundledSteps);
    if (!load.ok) throw new Error(`${flow}: ${load.error}`);
    return load.definition.steps.flatMap((s) => (s.loop === undefined ? [] : [s.loop]));
  };
  const hasLoopStep = (flow: string): boolean => {
    const doc = yaml.load(readFileSync(join(FLOWS_TREE, flow, 'flow.yaml'), 'utf8')) as { steps: { kind?: string }[] };
    return doc.steps.some((s) => s.kind === 'loop');
  };

  it('resolves every loop each shipped flow binds from that flow’s folder or the shared folder', () => {
    const flows = flowIds();
    expect(flows.length).toBeGreaterThan(0);
    for (const flow of flows) {
      const names = new Set(boundLoops(flow));
      if (hasLoopStep(flow)) expect(names.size, flow).toBeGreaterThan(0);
      for (const name of names) {
        const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir, flow });
        expect(r.ok, `${flow}/${name}: ${r.ok ? '' : r.reason}`).toBe(true);
        if (r.ok) {
          const own = r.def.work.recipe.startsWith(join(SOURCE_TREE, flow, name) + sep);
          const shared = r.def.work.recipe.startsWith(join(SOURCE_TREE, name) + sep);
          expect(own || shared, `${flow}/${name}`).toBe(true);
        }
      }
    }
  });

  it('every bundled loop folder Install examples lists is the folder the resolver loads it from', () => {
    const folders = listLoopFolders(SOURCE_TREE);
    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      const r = resolveLoopDefV2(folder.name, { tiers: { operator: null, appBundled: SOURCE_TREE, retired: null }, repoDir, flow: folder.flow ?? undefined });
      expect(r.ok && r.defDir, `${folder.flow ?? ''}/${folder.name}: ${r.ok ? '' : r.reason}`).toBe(folder.dir);
    }
  });

  it('every loop in the shared folder is bound by a shipped flow', () => {
    const bound = new Set(flowIds().flatMap(boundLoops));
    for (const folder of listLoopFolders(SOURCE_TREE)) {
      if (folder.flow === null) expect(bound.has(folder.name), folder.name).toBe(true);
    }
  });

  it('every loop Install examples treats as moved is gone from its flow’s folder and ships shared or is bound by no shipped flow', () => {
    const flows = new Set(flowIds());
    const bound = new Set(flowIds().flatMap(boundLoops));
    const shared = new Set(listLoopFolders(SOURCE_TREE).flatMap((f) => (f.flow === null ? [f.name] : [])));
    const entries = Object.entries(MOVED_LOOPS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [flow, loops] of entries) {
      expect(flows.has(flow), flow).toBe(true);
      for (const loop of loops) {
        expect(shared.has(loop) || !bound.has(loop), loop).toBe(true);
        expect(existsSync(join(SOURCE_TREE, flow, loop)), `${flow}/${loop}`).toBe(false);
      }
    }
  });

  it('Install examples treats exactly the five loops simple-dev-v1 once held as moved', () => {
    expect([...(MOVED_LOOPS['simple-dev-v1'] ?? [])].sort()).toEqual(
      [
        'simple-plan-approve-loop-v1',
        'simple-dev-loop-v1',
        'simple-integration-slice-loop-v1',
        'simple-impl-approve-loop-v1',
        'simple-finalize-loop-v1',
      ].sort(),
    );
  });

  it('no shared loop folder has the name of a shipped flow', () => {
    const flows = new Set(flowIds());
    for (const folder of listLoopFolders(SOURCE_TREE)) {
      if (folder.flow === null) expect(flows.has(folder.name), folder.name).toBe(false);
    }
  });
});
