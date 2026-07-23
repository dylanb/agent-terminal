import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';
import { completionArtifact } from '../../src/main/appWorkTurn';

// §27.9/§27.13 / N5 — the three shipped §27 loop defs declare an approve gate whose side-effect matches
// §27.13 (groom → update-issue-body, plan → mark-ready, impl → publish-pr-body), a request-changes option
// (sub-ticket 2) that runs NO gh side-effect, and — sub-ticket 3 — the redo and polish options (also no gh
// side-effect): redo re-enters the work turn on a clean slate (§27.9/AC5) and polish stands the orchestrator
// down (§27.9/AC6). The §27-illegal impasse is still never offered.

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

describe('shipped §27 loop defs — approve (§27.13 side-effect) + request-changes + redo + polish (no side-effect)', () => {
  it('groom-loop offers approve (publish the groomed ticket to the issue body), request-changes, redo, polish', () => {
    expect(gateActions(resolve('groom-loop'))).toEqual([
      { option: 'approve', actions: ['update-issue-body'] },
      { option: 'request-changes', actions: [] },
      { option: 'redo', actions: [] },
      { option: 'polish', actions: [] },
    ]);
  });

  it('plan-loop offers approve (flip the PR non-draft, mark-ready), request-changes, redo, polish', () => {
    expect(gateActions(resolve('plan-loop'))).toEqual([
      { option: 'approve', actions: ['mark-ready'] },
      { option: 'request-changes', actions: [] },
      { option: 'redo', actions: [] },
      { option: 'polish', actions: [] },
    ]);
  });

  it('impl-loop offers approve (publish the PR body), request-changes, redo, polish', () => {
    const resolved = resolve('impl-loop');
    expect(gateActions(resolved)).toEqual([
      { option: 'approve', actions: ['publish-pr-body'] },
      { option: 'request-changes', actions: [] },
      { option: 'redo', actions: [] },
      { option: 'polish', actions: [] },
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(completionArtifact(resolved.def)).toBeNull();
    expect(resolved.def.outputs).toEqual([]);
    expect(resolved.def.gate[0].sideEffects[0].args).toMatchObject({
      artifact: 'plan',
    });
  });

  it('every shipped def now offers redo and polish, and still never the §27-illegal impasse (§27.9/AC5,6,9)', () => {
    for (const name of ['groom-loop', 'plan-loop', 'impl-loop']) {
      const options = gateActions(resolve(name)).map((g) => g.option);
      expect(options).toContain('redo');
      expect(options).toContain('polish');
      expect(options).not.toContain('impasse');
    }
  });
});
