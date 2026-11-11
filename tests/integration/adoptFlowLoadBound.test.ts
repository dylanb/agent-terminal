import { FLOW_DEF_FILE } from '../../src/main/flowHome';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { createBoundSourceLoader } from '../../src/main/runResolver';
import { flowHomeDir } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { repoOnlyDefTiers } from '../helpers/defTiers';

// #304 AC 25 — a bound run's load (held-run rebind, the auto gate's current run) refuses an adopting flow that
// breaks the adoption rules, as the live load does.

const fx = createWorktreeFixture();
afterEach(() => fx.cleanup());

function worktree(otherGate: unknown[]): string {
  const wt = fx.makeWorktree('adopt-bound-wt');
  const def = (name: string, extra: Record<string, unknown>): string => {
    const dir = join(wt, 'loops', name);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'work.md'), 'work\n');
    writeFileSync(join(dir, `${name}.yaml`), dump({ version: 'v2', work: { recipe: 'prompts/work.md', artifact: 'report' }, reviewers: [], boundaries: [], report: { sections: ['summary'] }, outputs: [{ id: 'report', path: `${name}.md` }], ...extra }));
    return `loops/${name}/${name}.yaml`;
  };
  writeFileSync(join(wt, '.agent-loop.yaml'), dump({ loops: { 'review-loop': def('review-loop', { pickup: { adopt: 'pr' }, gate: [{ option: 'approve' }] }), 'other-loop': def('other-loop', { gate: otherGate }) } }));
  writeFileSync(
    join(flowHomeDir(wt), FLOW_DEF_FILE),
    dump({ name: 'adopt-bound', steps: [{ id: 'adopt-step', kind: 'loop', loop: 'review-loop', inputs: [{ name: 'pr', type: 'pr', required: true }] }, { id: 'other-step', kind: 'loop', loop: 'other-loop' }] }),
  );
  return wt;
}

describe('createBoundSourceLoader — the adoption rules hold for a bound run too (#304 AC 25)', () => {
  it("refuses a bound adopting flow whose other step's gate marks a PR ready, naming both steps", () => {
    const wt = worktree([{ option: 'approve', side_effects: [{ kind: 'gh', action: 'mark-ready' }] }]);
    const load = createBoundSourceLoader(fx.makeWorktree('adopt-bound-home'), repoOnlyDefTiers())(wt, { source: 'non-catalog' });
    const error = load.ok ? 'the flow loaded' : load.error;
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('other-step');
  });

  it('loads the same flow without the conflict', () => {
    const wt = worktree([{ option: 'approve' }]);
    expect(createBoundSourceLoader(fx.makeWorktree('adopt-bound-home'), repoOnlyDefTiers())(wt, { source: 'non-catalog' }).ok).toBe(true);
  });
});
