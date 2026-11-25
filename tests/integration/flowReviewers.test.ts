import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { flowReviewers } from '../../src/main/runReviewers';

const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');
const resolve = (loop: string) => resolveLoopDefV2(loop, { tiers: { operator: null, appBundled: BUNDLE_LOOPS, retired: null }, repoDir: BUNDLE_LOOPS, flow: 'feature-dev-v3' });

describe('the reviewers a run installs at Start', () => {
  it('requires no reviewers for a step bound to a retired engine', () => {
    const steps = [{ kind: 'loop' as const, loop: 'no-such-loop', loopNamespace: 'legacy' as const }];
    expect(() => flowReviewers(steps, resolve)).not.toThrow();
    expect(flowReviewers(steps, resolve)).toEqual({ reviewers: [], problems: [] });
  });
  it('refuses an unresolved loop instead of silently installing an incomplete catalog', () => {
    expect(flowReviewers([{ kind: 'loop', loop: 'no-such-loop' }], resolve).problems.join('\n')).toMatch(/no-such-loop/);
  });
  it('names every unresolved loop in one refusal', () => {
    expect(flowReviewers([{ kind: 'loop', loop: 'absent-first' }, { kind: 'loop', loop: 'absent-second' }], resolve).problems.join('\n')).toMatch(/absent-first[\s\S]*absent-second/);
  });
  it('collects every reviewer of every loop step, skipping manual steps', () => {
    const steps = [
      { kind: 'manual' as const },
      { kind: 'loop' as const, loop: 'red-loop' },
      { kind: 'loop' as const, loop: 'green-loop' },
    ];

    const loops = new Set(flowReviewers(steps, resolve).reviewers.map((r) => r.loop));

    expect(loops).toEqual(new Set(['red-loop', 'green-loop']));
    const green = resolve('green-loop');
    if (!green.ok) throw new Error(green.reason);
    expect(flowReviewers(steps, resolve).reviewers.filter((r) => r.loop === 'green-loop').map((r) => r.persona).sort()).toEqual(green.def.reviewers.map((r) => r.persona).sort());
  });
});
