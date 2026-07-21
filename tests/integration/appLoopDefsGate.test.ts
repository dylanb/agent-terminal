import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';

// §27.9/§27.13 / N5 — the three shipped §27 loop defs declare an approve gate whose side-effect matches
// §27.13 (groom → update-issue-body, plan → mark-ready, impl → publish-pr-body) AND a request-changes option
// (sub-ticket 2) that runs NO gh side-effect — it returns the loop to a review-and-fix round carrying the
// operator's feedback (§27.9/AC4). Redo/polish and the §27-illegal impasse are still not offered.

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

describe('shipped §27 loop defs — approve (§27.13 side-effect) + request-changes (no side-effect)', () => {
  it('groom-loop offers approve (publish the groomed ticket to the issue body) and request-changes', () => {
    expect(gateActions(resolve('groom-loop'))).toEqual([
      { option: 'approve', actions: ['update-issue-body'] },
      { option: 'request-changes', actions: [] },
    ]);
  });

  it('plan-loop offers approve (flip the PR non-draft, mark-ready) and request-changes', () => {
    expect(gateActions(resolve('plan-loop'))).toEqual([
      { option: 'approve', actions: ['mark-ready'] },
      { option: 'request-changes', actions: [] },
    ]);
  });

  it('impl-loop offers approve (publish the PR body) and request-changes', () => {
    expect(gateActions(resolve('impl-loop'))).toEqual([
      { option: 'approve', actions: ['publish-pr-body'] },
      { option: 'request-changes', actions: [] },
    ]);
  });

  it('no shipped def offers redo, polish, or the §27-illegal impasse (those are not this slice)', () => {
    for (const name of ['groom-loop', 'plan-loop', 'impl-loop']) {
      const options = gateActions(resolve(name)).map((g) => g.option);
      expect(options).not.toContain('redo');
      expect(options).not.toContain('polish');
      expect(options).not.toContain('impasse');
    }
  });
});
