import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAppLoopView } from '../../src/main/loopViewV2';
import type { LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { writeAppLoopState } from '../../src/main/appLoopState';

// §27.11/§27.15 — the loop view's cost readout is engine-neutral and carries no engine-specific data: the
// §27 provider populates it from the meter's in-memory figure, so the strip still never learns there are
// two engines. The figure is HANDED to the provider; nothing here sweeps or parses.

const DEF = `version: v2
name: plan-loop
work:
  recipe: prompts/work.md
  artifact: plan
reviewers:
  []
consolidator:
  recipe: prompts/consolidate.md
boundaries: []
report:
  sections: [summary]
gate:
  - option: approve
    side_effects: []
pickup:
  initial_status: planning
  branch_template: plan-loop/issue-{issue}
`;

let appDir: string;
let repoDir: string;

function tiers(): LoopDefV2Tiers {
  return { operator: null, appBundled: join(appDir, 'loops-v2') };
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'lv2cost-app-'));
  repoDir = mkdtempSync(join(tmpdir(), 'lv2cost-repo-'));
  const defDir = join(appDir, 'loops-v2', 'plan-loop');
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(defDir, 'prompts', 'consolidate.md'), 'judge\n');
  writeFileSync(join(defDir, 'plan-loop.yaml'), DEF);
});
afterEach(() => {
  for (const d of [appDir, repoDir]) rmSync(d, { recursive: true, force: true });
});

describe('the §27 loop view`s cost readout', () => {
  it('carries the run`s figure on a live run-state view', () => {
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' });
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir }, null, '$4.50');
    expect(view.cost).toBe('$4.50');
  });

  // AC 2's no-recorded-start figure is read from a step that records no floor, which is a run-LESS view:
  // a readout that only rides the run-state view has nowhere to show it.
  it('carries the run`s figure on a run-less view', () => {
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir }, null, '$1.25');
    expect(view.status).toBe('not-started');
    expect(view.cost).toBe('$1.25');
  });

  // §27.12c — the LIVE-error view is the route out when the status:error write itself could not land. It is
  // the fourth and last shape the provider returns, and the shape a run is in when the operator most wants
  // to know what it has already cost.
  it('carries the run`s figure on a live-error view, so the route-out view still prices', () => {
    const view = deriveAppLoopView(
      'plan-loop',
      { tiers: tiers(), repoDir },
      { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', reason: 'state write refused' },
      '$4.50',
    );
    expect(view.status).toBe('error');
    expect(view.errorReason).toBe('state write refused');
    expect(view.cost).toBe('$4.50');
  });

  it('carries the run`s figure on a def-failure view, so a failed run still prices', () => {
    const view = deriveAppLoopView('no-such-loop', { tiers: tiers(), repoDir }, null, '$0.75');
    expect(view.status).toBe('error');
    expect(view.cost).toBe('$0.75');
  });

  it('omits the readout entirely when the meter has no figure yet', () => {
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' });
    expect(deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir }, null, null).cost).toBeUndefined();
  });

  it('never renders NaN: an all-unpriced run reads the unknown marker', () => {
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir }, null, 'unknown');
    expect(view.cost).toBe('unknown');
    expect(view.cost).not.toContain('NaN');
  });
});
