import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';

// §27.13 / N5 — the three shipped §27 loop defs declare an approve gate whose side-effect matches §27.13, and
// NOTHING ELSE: groom → update-issue-body, plan → PR non-draft flip (mark-ready), impl → PR-body publish. This
// slice corrects the plan/impl swap and narrows every def to approve-only, so the actionable gate never
// renders an unwired control (request-changes lands in a later slice; the §27-illegal impasse is removed).

const APP_BUNDLED = join(process.cwd(), 'example', 'loops-v2');

let repoDir: string;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'app-defs-'));
});
afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function resolve(name: string): LoopDefV2Result {
  return resolveLoopDefV2(name, { tiers: { operator: null, appBundled: APP_BUNDLED }, repoDir });
}

const gateActions = (r: LoopDefV2Result): Array<{ option: string; actions: string[] }> => {
  if (!r.ok) throw new Error(`def did not resolve: ${r.reason}`);
  return r.def.gate.map((g) => ({
    option: g.option,
    actions: g.sideEffects.filter((se) => se.kind === 'gh').map((se) => String(se.args.action)),
  }));
};

describe('shipped §27 loop defs — approve-only gate with the §27.13 side-effect', () => {
  it('groom-loop approve publishes the groomed ticket to the issue body, and offers no other option', () => {
    expect(gateActions(resolve('groom-loop'))).toEqual([{ option: 'approve', actions: ['update-issue-body'] }]);
  });

  it('plan-loop approve flips the PR non-draft (mark-ready), and offers no other option', () => {
    expect(gateActions(resolve('plan-loop'))).toEqual([{ option: 'approve', actions: ['mark-ready'] }]);
  });

  it('impl-loop approve publishes the PR body, and offers no other option', () => {
    expect(gateActions(resolve('impl-loop'))).toEqual([{ option: 'approve', actions: ['publish-pr-body'] }]);
  });
});
