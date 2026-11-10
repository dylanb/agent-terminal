import { describe, expect, it } from 'vitest';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { BUNDLED_LOOPS_ROOT, REPO_DIR } from '../helpers/bundledLoops';
import { redTestChangesArtifact } from '../../src/main/redTestChanges';

const V3 = 'feature-dev-v3';

function loop(name: string): LoopDefV2 {
  const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir: REPO_DIR, flow: V3 });
  if (!r.ok) throw new Error(r.reason);
  return r.def;
}

describe('feature-dev-v3 loops read what an earlier step or the engine writes', () => {
  it('the final approval reads the RED test change record where the engine writes it', () => {
    const record = loop('impl-approve-loop').inputs.find((i) => i.id === 'red-test-changes');
    expect(record?.path).toBe(redTestChangesArtifact(REPO_DIR));
  });

  it('approving the plan promotes the same file the plan step writes', () => {
    const approve = loop('plan-approve-loop');
    const promoted = approve.gate.find((g) => g.option === 'approve')?.sideEffects.find((se) => se.kind === 'promote')?.args.artifact;
    const binding = [...approve.inputs, ...approve.outputs].find((b) => b.id === promoted);
    expect(binding?.path).toBeDefined();
    expect(binding?.path).toBe(loop('plan-goal-loop').outputs.find((o) => o.id === 'plan')?.path);
  });
});
