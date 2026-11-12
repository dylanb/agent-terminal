import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { flowReviewers } from '../../src/main/runReviewers';

const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');
const resolve = (loop: string) => resolveLoopDefV2(loop, { tiers: { operator: null, appBundled: BUNDLE_LOOPS, retired: null }, repoDir: BUNDLE_LOOPS, flow: 'feature-dev-v3' });

describe('the reviewers a run installs at Start', () => {
  it('collects every reviewer of every loop step, skipping manual steps and loops that do not resolve', () => {
    const steps = [
      { kind: 'manual' as const },
      { kind: 'loop' as const, loop: 'red-loop' },
      { kind: 'loop' as const, loop: 'green-loop' },
      { kind: 'loop' as const, loop: 'no-such-loop' },
    ];

    const loops = new Set(flowReviewers(steps, resolve).map((r) => r.loop));

    expect(loops).toEqual(new Set(['red-loop', 'green-loop']));
    const green = resolve('green-loop');
    if (!green.ok) throw new Error(green.reason);
    expect(flowReviewers(steps, resolve).filter((r) => r.loop === 'green-loop').map((r) => r.persona).sort()).toEqual(green.def.reviewers.map((r) => r.persona).sort());
  });
});
