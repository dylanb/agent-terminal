import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFlowDefinitionFromFile, type FlowStepDef } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { BUNDLED_LOOPS_ROOT, REPO_DIR } from '../helpers/bundledLoops';

const FLOW = 'simple-dev-v1';

function steps(): FlowStepDef[] {
  const file = path.join(resolveExampleFlowsDir({ packaged: false, appPath: REPO_DIR }), FLOW, 'flow.yaml');
  const load = loadFlowDefinitionFromFile(file);
  if (!load.ok) throw new Error(load.error);
  return load.definition.steps;
}

function loopOf(step: FlowStepDef): LoopDefV2 {
  if (step.loop === undefined) throw new Error(`step ${step.id} names no loop`);
  const r = resolveLoopDefV2(step.loop, { tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir: REPO_DIR, flow: FLOW });
  if (!r.ok) throw new Error(`${step.id}: ${r.reason}`);
  return r.def;
}

const loopSteps = (): FlowStepDef[] => steps().filter((s) => s.kind === 'loop');

describe('the bundled simple-dev-v1 flow is runnable', () => {
  it('loads, and every loop step resolves to a loop shipped for this flow', () => {
    expect(loopSteps().length).toBeGreaterThan(0);
    for (const step of loopSteps()) expect(() => loopOf(step)).not.toThrow();
  });

  it('every loop input is written by that step or an earlier one', () => {
    const written = new Set<string>();
    for (const step of loopSteps()) {
      const def = loopOf(step);
      for (const o of def.outputs) written.add(o.path);
      for (const i of def.inputs) expect(written.has(i.path), `${step.id} reads ${i.id} (${i.path}), which no step up to it writes`).toBe(true);
    }
  });

  it('a back-to-red decision returns to a step at or before every gate that offers it', () => {
    const all = steps();
    const target = all.find((s) => s.repeat)?.repeat?.backTo;
    expect(target).toBeDefined();
    const targetIndex = all.findIndex((s) => s.id === target);
    const offering = loopSteps().filter((s) => loopOf(s).gate.some((g) => g.option === 'back-to-red'));
    for (const s of offering) expect(all.findIndex((x) => x.id === s.id), `${s.id} offers back-to-red before the step it returns to`).toBeGreaterThanOrEqual(targetIndex);
  });

  it('a ticket is picked up by the step that takes it as input', () => {
    const ticketStep = steps().find((s) => (s.inputs ?? []).some((i) => i.type === 'github-ticket'));
    expect(ticketStep).toBeDefined();
    expect(loopOf(ticketStep!).pickup).not.toBeNull();
  });
});
