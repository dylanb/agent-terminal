import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';
import { BUNDLED_LOOPS_ROOT, bundledFlowOf } from '../helpers/bundledLoops';

// §27.9/§27.13 / N5 — the shipped groom and plan §27 loop defs declare an approve gate whose side-effect
// matches §27.13 (groom → update-issue-body, plan → mark-ready), a request-changes option
// (sub-ticket 2) that runs NO gh side-effect, and — sub-ticket 3 — the redo and polish options (also no gh
// side-effect): redo re-enters the work turn on a clean slate (§27.9/AC5) and polish stands the orchestrator
// down (§27.9/AC6). The §27-illegal impasse is still never offered.

let repoDir: string;
beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'app-defs-'));
});
afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

function resolve(name: string): LoopDefV2Result {
  return resolveLoopDefV2(name, { tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir, flow: bundledFlowOf(name) });
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

  it('every shipped def now offers redo and polish, and still never the §27-illegal impasse (§27.9/AC5,6,9)', () => {
    for (const name of ['groom-loop', 'plan-loop']) {
      const options = gateActions(resolve(name)).map((g) => g.option);
      expect(options).toContain('redo');
      expect(options).toContain('polish');
      expect(options).not.toContain('impasse');
    }
  });
});

// §28.4.2 — the human back-to-red control is declared on EVERY phase gate (RED / GREEN / refactor /
// integration-slice), and only there: it re-enters the current slice's RED step, so it makes no sense at the
// non-phase gates (groom / plan). Like redo/polish it runs no gh side-effect (one-way).
describe('shipped §28 PHASE loop defs — the back-to-red control on every phase gate (§28.4.2)', () => {
  for (const name of ['red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop']) {
    it(`${name} offers back-to-red with no gh side-effect, alongside approve/request-changes/redo/polish`, () => {
      const opts = gateActions(resolve(name));
      const backToRed = opts.find((o) => o.option === 'back-to-red');
      expect(backToRed, `${name} must declare a back-to-red gate option`).toBeDefined();
      expect(backToRed?.actions).toEqual([]); // one-way: it reopens the slice, it never runs a gh side-effect
      const options = opts.map((o) => o.option);
      expect(options).toContain('redo');
      expect(options).toContain('polish');
      expect(options).not.toContain('impasse');
    });
  }

  it('leaves the non-phase gates WITHOUT back-to-red — the control belongs to the slice phases only', () => {
    for (const name of ['groom-loop', 'plan-loop', 'plan-goal-loop', 'plan-approve-loop']) {
      expect(gateActions(resolve(name)).map((g) => g.option), name).not.toContain('back-to-red');
    }
  });
});
