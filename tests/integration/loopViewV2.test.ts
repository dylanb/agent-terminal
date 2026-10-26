import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAppLoopView, provideAppLoopView, type AutoGateViewFor } from '../../src/main/loopViewV2';
import type { FlowAutoGateView } from '../../src/shared/ipc';
import type { LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { writeAppLoopState, enterPolish, recordChangedTests } from '../../src/main/appLoopState';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { exampleEpicPlan } from '../../src/shared/epicPlan';

// The §27 loop-view provider (the READ meeting point, engine-selected on the flow step's `app` namespace):
// it resolves the bound app-def and produces the whole loop view the strip/panel render — a run-less view
// (gate options display-only, no round has run) or a def-failure view carrying the reason (AC 6). It reads
// no retired-engine loop state, so a §27 step renders with the retired engine's defs and loop state both absent (AC "neither path").

const DEF = (opts: string[], reviewers: string[] = []): string => `version: v2
name: plan-loop
work:
  recipe: prompts/work.md
  artifact: plan
reviewers:
${reviewers.length === 0 ? '  []' : reviewers.map((p) => `  - persona: ${p}\n    charter: charter/${p}.md\n    tools: [Read]`).join('\n')}
consolidator:
  recipe: prompts/consolidate.md
boundaries: []
report:
  sections: [summary]
gate:
${opts.map((o) => `  - option: ${o}\n    side_effects: []`).join('\n')}
pickup:
  initial_status: planning
  branch_template: plan-loop/issue-{issue}
`;

let appDir: string;
let repoDir: string;
function tiers(): LoopDefV2Tiers {
  return { operator: null, appBundled: join(appDir, 'loops-v2'), retired: null };
}
function plant(name: string, opts: string[], reviewers: string[] = []): void {
  const defDir = join(appDir, 'loops-v2', name);
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  mkdirSync(join(defDir, 'charter'), { recursive: true });
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(defDir, 'prompts', 'consolidate.md'), 'judge\n');
  for (const p of reviewers) writeFileSync(join(defDir, 'charter', `${p}.md`), `charter for ${p}\n`);
  writeFileSync(join(defDir, `${name}.yaml`), DEF(opts, reviewers).replace('name: plan-loop', `name: ${name}`));
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'lv2-app-'));
  repoDir = mkdtempSync(join(tmpdir(), 'lv2-repo-'));
});
afterEach(() => {
  for (const d of [appDir, repoDir]) rmSync(d, { recursive: true, force: true });
});

describe('deriveAppLoopView — run-less view (AC 1)', () => {
  it('renders the resolved def\'s gate options display-only, with no round having run', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.gateOptions).toEqual(['approve', 'request-changes']);
    expect(view.actionable).toBe(false); // display-only — the guard is at the operation, not the render
    expect(view.iteration).toBeUndefined(); // no round has run — not a fabricated 0
    expect(view.humanNeeded).toBe(false);
    expect(view.ready).toBe(false);
  });

  it('differs between defs that declare different gate options', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    plant('groom-loop', ['approve', 'reject']);
    const plan = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    const groom = deriveAppLoopView('groom-loop', { tiers: tiers(), repoDir });
    expect(plan.gateOptions).toEqual(['approve', 'request-changes']);
    expect(groom.gateOptions).toEqual(['approve', 'reject']);
  });
});

describe('deriveAppLoopView — def-failure view (AC 6)', () => {
  it('surfaces the reason for an unresolvable def, marked human-needed with no round', () => {
    const view = deriveAppLoopView('nowhere-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('error');
    expect(view.errorReason).toContain('nowhere-loop');
    expect(view.humanNeeded).toBe(true);
    expect(view.iteration).toBeUndefined();
    expect(view.actionable).toBe(false);
  });

  it('surfaces the reason for a malformed def rather than throwing', () => {
    const defDir = join(appDir, 'loops-v2', 'plan-loop');
    mkdirSync(defDir, { recursive: true });
    writeFileSync(join(defDir, 'plan-loop.yaml'), 'version: v2\nname: [unterminated');
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('error');
    expect(view.errorReason).toBeTruthy();
  });
});

// §27.12 — once a work turn has run, the provider mirrors the live §27 run-state (working/error/complete)
// carrying the turn identity the route-out acts on, instead of the run-less view. The error status is
// classified human-needed by the SHARED predicate (loopStatus), so both engines agree.
describe('deriveAppLoopView — live run-state (AC1, AC7)', () => {
  const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');

  it('mirrors a running work turn: status working, human not needed, the turn identity, no gate', () => {
    plant('plan-loop', ['approve']);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('working');
    expect(view.humanNeeded).toBe(false);
    expect(view.actionable).toBe(false);
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'work-plan' });
    expect(view.iteration).toBeUndefined(); // no round has run
    expect(view.errorReason).toBeUndefined();
    // §27.6/AC5 Non-goals — the gate's options preview belongs at the TERMINAL consolidator gate, not during
    // an active mid-loop turn; a `working` run-state has reached no verdict, so it carries no gate options.
    expect(view.gateOptions).toBeUndefined();
  });

  it('mirrors an errored work turn: status error, human-needed by the shared predicate, its reason + identity', () => {
    plant('plan-loop', ['approve']);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'error', errorReason: 'stalled: no terminal activity' },
      FIXED,
    );
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('error');
    expect(view.humanNeeded).toBe(true);
    expect(view.errorReason).toBe('stalled: no terminal activity');
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'work-plan' });
  });

  it('mirrors a completed work turn: status complete, human not needed', () => {
    plant('plan-loop', ['approve']);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'complete' }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('complete');
    expect(view.humanNeeded).toBe(false);
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'work-plan' });
  });

  // §27.5/§27 IPC item 3 — the view begins carrying the round number in the existing optional `iteration`
  // field once a review-and-fix round has run; it stays absent through the work turn (no fabricated 0).
  it('carries the review round number in the iteration field for a running review turn', () => {
    plant('plan-loop', ['approve']);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working', round: 1 }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('working');
    expect(view.iteration).toBe(1);
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'review-plan' });
    expect(view.gateOptions).toBeUndefined(); // a mid-loop review round is not at the gate (§27.6/AC5)
  });

  it('carries the round number on an errored review turn (route-out surfaces it)', () => {
    plant('plan-loop', ['approve']);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'error', errorReason: 'report omits a roster persona', round: 1 },
      FIXED,
    );
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('error');
    expect(view.iteration).toBe(1);
    expect(view.humanNeeded).toBe(true);
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'review-plan' });
  });

  it('ignores a run-state belonging to a DIFFERENT loop (falls back to the run-less view)', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    writeAppLoopState(repoDir, { loop: 'groom-loop', step: 'groom', turnKey: 'work-groom', status: 'working' }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.status).toBe('not-started'); // the stale run-state is not this loop's
    expect(view.gateOptions).toEqual(['approve', 'request-changes']);
    expect(view.appTurn).toBeUndefined();
  });
});

// §27.4/§27.6/AC5/AC8 — once a roster is selected the view surfaces the def's reviewer catalog and the
// consolidator's chosen roster (both parsed-def data), plus the round's verdict and (for stop-for-a-human)
// its reason, so the panel can render them.
describe('deriveAppLoopView — the catalog, chosen roster, and verdict (AC5, AC8)', () => {
  const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');
  const CATALOG = ['review-plan-principal', 'review-plan-security', 'review-plan-contracts'];

  it('surfaces the def reviewer catalog whenever the def resolves (AC8)', () => {
    plant('plan-loop', ['approve'], CATALOG);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working', round: 2 }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.catalog).toEqual(CATALOG);
  });

  it('surfaces the consolidator chosen roster from the run-state (AC8)', () => {
    plant('plan-loop', ['approve'], CATALOG);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working', round: 2, chosenRoster: ['review-plan-security'] },
      FIXED,
    );
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.catalog).toEqual(CATALOG);
    expect(view.chosenRoster).toEqual(['review-plan-security']);
  });

  it('surfaces the verdict and (for stop-for-a-human) its reason at the gate (AC5)', () => {
    plant('plan-loop', ['approve'], CATALOG);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 2, verdict: 'stop for a human', verdictReason: 'reviewers disagree' },
      FIXED,
    );
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.verdict).toBe('stop for a human');
    expect(view.verdictReason).toBe('reviewers disagree');
  });

  it('carries no verdict/roster for a plain work turn (absent = none chosen yet)', () => {
    plant('plan-loop', ['approve'], CATALOG);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.verdict).toBeUndefined();
    expect(view.chosenRoster).toBeUndefined();
    expect(view.catalog).toEqual(CATALOG); // the catalog still shows (AC8)
  });

  // §27.9/N5 (AC1) — the terminal consolidator gate is the loop's human interface: its declared options become
  // CLICKABLE (actionable), and the loop is blocked awaiting the human's decision (humanNeeded). The refusal
  // guard for an undeclared option stays at the operation. Supersedes N4's display-only gate.
  it('makes the terminal consolidator gate ACTIONABLE and human-needed, carrying the def gate options (AC1)', () => {
    plant('plan-loop', ['approve', 'request-changes'], CATALOG);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 2, verdict: 'clean' },
      FIXED,
    );
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.gateOptions).toEqual(['approve', 'request-changes']);
    expect(view.actionable).toBe(true); // N5 — the gate is actionable (clickable controls render)
    expect(view.humanNeeded).toBe(true); // the loop is blocked awaiting the human's gate decision
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'consolidate-plan' }); // the identity the decision acts on
  });

  it('keeps a mid-loop working turn display-only and not a gate (no verdict → not actionable)', () => {
    // A running turn is never a gate: no verdict reached, so no clickable controls and no gate options.
    plant('plan-loop', ['approve'], CATALOG);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }, FIXED);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.actionable).toBe(false);
    expect(view.gateOptions).toBeUndefined();
  });

  // §27.9/N5 (AC6/AC11) — a polish stand-down active for the gated step turns the view into the polish view: it
  // still renders at the gate (actionable, human-needed) but offers ONLY the approve control (which ends polish),
  // never the full option set, and carries `polish: true` so the panel shows the stand-down. Persisted
  // independently, so it survives a relaunch (this derive reads it fresh each pull).
  it('a polish stand-down at the gate narrows the options to approve and marks the view polish (AC6/AC11)', () => {
    plant('plan-loop', ['approve', 'request-changes', 'redo', 'polish'], CATALOG);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 2, verdict: 'clean' },
      FIXED,
    );
    enterPolish(repoDir, 'plan'); // the operator entered polish (persisted in its own file)
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.polish).toBe(true);
    expect(view.gateOptions).toEqual(['approve']); // only approve ends polish — the other levers are withdrawn
    expect(view.actionable).toBe(true); // approve is still clickable
    expect(view.humanNeeded).toBe(true); // still blocked on the human
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'consolidate-plan' });
  });

  it('a polish stand-down for a DIFFERENT step does not affect this gate view', () => {
    plant('plan-loop', ['approve', 'request-changes', 'redo', 'polish'], CATALOG);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 2, verdict: 'clean' },
      FIXED,
    );
    enterPolish(repoDir, 'implement'); // a stand-down for another step, not this gate's
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.polish).toBeUndefined();
    expect(view.gateOptions).toEqual(['approve', 'request-changes', 'redo', 'polish']); // the full gate
  });

  // §27.9/N5 (AC6) + CLAUDE.md "never allow an unrecoverable state" — the polish view narrows to approve (the
  // one lever that ends polish). An operator-authored def (the `operator` tier is a supported, tested path) can
  // declare a gate with `polish` but no `approve`; narrowing to approve-only would then leave the operator at an
  // actionable, human-needed gate with ZERO controls — a dead end. The narrowing must fail toward still showing
  // the def's controls, never toward an empty gate: only narrow when narrowing still leaves a route out.
  it('never narrows to an empty gate — a def declaring polish without approve keeps its full controls (AC6)', () => {
    plant('plan-loop', ['request-changes', 'redo', 'polish'], CATALOG); // no approve declared
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 2, verdict: 'clean' },
      FIXED,
    );
    enterPolish(repoDir, 'plan');
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.gateOptions).toEqual(['request-changes', 'redo', 'polish']); // never [] — the operator keeps a route out
  });

  it('a polish flag on a non-gate (working) run is ignored — polish is a gate-only view', () => {
    plant('plan-loop', ['approve', 'request-changes', 'redo', 'polish'], CATALOG);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' }, FIXED);
    enterPolish(repoDir, 'plan');
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.polish).toBeUndefined();
    expect(view.actionable).toBe(false);
    expect(view.gateOptions).toBeUndefined();
  });
});

// CWE-703 recovery — when the status:error write fails (ENOSPC/EPERM/a planted symlink) the persisted state
// cannot record the error, so the engine hands the provider its LIVE in-memory error. The provider surfaces
// it (status error + the route-out identity + human-needed) so the §27 route-out is never a dead-end.
describe('deriveAppLoopView — live-error fallback when the persisted state cannot reflect it', () => {
  it('surfaces the engine live error + route-out identity when no error is persisted', () => {
    plant('plan-loop', ['approve']);
    const view = deriveAppLoopView(
      'plan-loop',
      { tiers: tiers(), repoDir },
      { kind: 'turn-error', loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', reason: 'stalled: no terminal activity' },
    );
    expect(view.status).toBe('error');
    expect(view.humanNeeded).toBe(true);
    expect(view.errorReason).toBe('stalled: no terminal activity');
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'work-plan' });
    expect(view.iteration).toBeUndefined(); // a work-turn live error carries no round
  });

  it('carries the round number on a review-turn live error (persisted error write failed)', () => {
    plant('plan-loop', ['approve']);
    const view = deriveAppLoopView(
      'plan-loop',
      { tiers: tiers(), repoDir },
      { kind: 'turn-error', loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', reason: 'malformed report', round: 1 },
    );
    expect(view.status).toBe('error');
    expect(view.iteration).toBe(1);
    expect(view.appTurn).toEqual({ step: 'plan', turnKey: 'review-plan' });
  });

  it('says a stalled turn is stalled, so the panel can say how to get the agent going (§27.12)', () => {
    plant('plan-loop', ['approve']);
    const live = { kind: 'turn-error' as const, loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', reason: 'stalled: no terminal activity' };
    expect(deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir }, { ...live, stalled: true }).stalled).toBe(true);
    expect(deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir }, live).stalled).toBeUndefined();
  });

  it('ignores a live error belonging to a different loop (falls back to the run-less view)', () => {
    plant('plan-loop', ['approve']);
    const view = deriveAppLoopView(
      'plan-loop',
      { tiers: tiers(), repoDir },
      { kind: 'turn-error', loop: 'groom-loop', step: 'groom', turnKey: 'work-groom', reason: 'x' },
    );
    expect(view.status).toBe('not-started');
    expect(view.appTurn).toBeUndefined();
  });
});

// §28.5.3/§28.8.3 — the changed-tests flag surfaces on the loop view when the machine detected a test-glob file
// changed during a GREEN turn (recorded under the run's step). Non-blocking detect-and-escalate: it rides the
// view for the review round + human gate to see. A step-mismatched or empty (clean-green) record does not show.
describe('deriveAppLoopView — the changed-tests flag (§28.5.3)', () => {
  const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');
  const seedRun = (step = 'plan'): void => {
    plant('plan-loop', ['approve'], ['review-plan-principal']);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step, turnKey: 'consolidate-plan', status: 'complete', round: 2, verdict: 'clean' },
      FIXED,
    );
  };

  it('surfaces the changed-test flag naming the files recorded under the run step', () => {
    seedRun('plan');
    recordChangedTests(repoDir, 'plan', ['tests/a.test.ts', 'tests/b.test.ts']);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.changedTests).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('does NOT surface a flag recorded under a DIFFERENT step (step-match, §12)', () => {
    seedRun('plan');
    recordChangedTests(repoDir, 'some-other-step', ['tests/a.test.ts']);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.changedTests).toBeUndefined();
  });

  it('does NOT surface an empty-paths flag (a clean GREEN records [], which is not a flag to show)', () => {
    seedRun('plan');
    recordChangedTests(repoDir, 'plan', []);
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.changedTests).toBeUndefined();
  });

  it('does NOT surface a flag when none was recorded', () => {
    seedRun('plan');
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.changedTests).toBeUndefined();
  });
});

// §28.7 — the epic overlay: when an epic-capable loop (its approve gate declares a `promote` side-effect) reaches
// its gate and its `plan` artifact is classified an epic, the view carries the parsed sub-ticket split so the
// panel can show the operator what promotion will create BEFORE they approve (§27.10 "the plan gate is where a
// human judges whether the split is right"). Derived main-side from the same epicPlan grammar promotion reads.
describe('deriveAppLoopView — epic classification at the gate (§28.7)', () => {
  const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');
  const EPIC_DEF = (name: string, promote: boolean): string => `version: v2
name: ${name}
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
    side_effects:${promote ? '\n      - kind: promote\n        artifact: plan' : ' []'}
outputs:
  - id: plan
    path: plan.md
`;
  function plantEpic(name: string, promote: boolean): void {
    const defDir = join(appDir, 'loops-v2', name);
    mkdirSync(join(defDir, 'prompts'), { recursive: true });
    writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
    writeFileSync(join(defDir, 'prompts', 'consolidate.md'), 'judge\n');
    writeFileSync(join(defDir, `${name}.yaml`), EPIC_DEF(name, promote));
  }
  function writePlanArtifact(text: string): void {
    const dir = join(repoDir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.md'), text);
  }
  function seedGate(name: string): void {
    writeAppLoopState(
      repoDir,
      { loop: name, step: 'plan-bundle', turnKey: 'consolidate-plan-bundle', status: 'complete', round: 1, verdict: 'clean' },
      FIXED,
    );
  }

  it('surfaces the parsed sub-ticket split when the gate plan is classified an epic', () => {
    plantEpic('plan-bundle-loop', true);
    writePlanArtifact(exampleEpicPlan(3));
    seedGate('plan-bundle-loop');
    const view = deriveAppLoopView('plan-bundle-loop', { tiers: tiers(), repoDir });
    expect(view.epic?.subTickets.map((t) => t.index)).toEqual([1, 2, 3]);
    // a concrete title, so a regression mapping the wrong field (e.g. body) into `title` is caught
    expect(view.epic?.subTickets[0].title).toBe('Slice 1 of the feature');
  });

  it('still renders the gate (no epic) when the plan artifact is absent — a momentary miss must not throw', () => {
    plantEpic('plan-bundle-loop', true);
    seedGate('plan-bundle-loop'); // no writePlanArtifact — the artifact does not exist
    const ctx = { tiers: tiers(), repoDir };
    expect(() => deriveAppLoopView('plan-bundle-loop', ctx)).not.toThrow();
    expect(deriveAppLoopView('plan-bundle-loop', ctx).epic).toBeUndefined();
  });

  it('caps the plan read (CWE-400): an oversized plan artifact yields no epic and does not block/throw', () => {
    plantEpic('plan-bundle-loop', true);
    // a well-formed epic plan padded past the 2 MiB read cap
    writePlanArtifact(`${exampleEpicPlan(2)}\n${'x'.repeat(3 * 1024 * 1024)}\n`);
    seedGate('plan-bundle-loop');
    const ctx = { tiers: tiers(), repoDir };
    expect(() => deriveAppLoopView('plan-bundle-loop', ctx)).not.toThrow();
    expect(deriveAppLoopView('plan-bundle-loop', ctx).epic).toBeUndefined();
  });

  it('carries no epic split when the gate plan is a plain single-ticket plan', () => {
    plantEpic('plan-bundle-loop', true);
    writePlanArtifact('# plan\n\na single-ticket plan\n');
    seedGate('plan-bundle-loop');
    const view = deriveAppLoopView('plan-bundle-loop', { tiers: tiers(), repoDir });
    expect(view.epic).toBeUndefined();
  });

  it('carries no epic split when a NOT-well-formed epic plan would silently drop a slice (dup index)', () => {
    // A plan classified an epic but malformed — a repeated sub-ticket index — must not raise a promotable
    // preview: the executor keys on index, so promoting it would create fewer issues than the preview names
    // (a silent loss of an approved slice on an irreversible action). The gate rejects it via epicPlanWellFormed.
    plantEpic('plan-bundle-loop', true);
    writePlanArtifact(['Classification: epic', '## Sub-tickets',
      '### Sub-ticket 1 — Slice A', 'Acceptance criteria: a',
      '### Sub-ticket 1 — Slice B', 'Acceptance criteria: b', ''].join('\n'));
    seedGate('plan-bundle-loop');
    expect(deriveAppLoopView('plan-bundle-loop', { tiers: tiers(), repoDir }).epic).toBeUndefined();
  });

  it('carries no epic split when a sub-ticket is missing its acceptance-criteria line (not well-formed)', () => {
    plantEpic('plan-bundle-loop', true);
    writePlanArtifact('Classification: epic\n\n## Sub-tickets\n\n### Sub-ticket 1 — No AC here\n\nsome plan text\n');
    seedGate('plan-bundle-loop');
    expect(deriveAppLoopView('plan-bundle-loop', { tiers: tiers(), repoDir }).epic).toBeUndefined();
  });

  it('carries no epic split for a loop whose gate declares no promote side-effect', () => {
    plantEpic('plan-loop', false);
    writePlanArtifact(exampleEpicPlan(2));
    seedGate('plan-loop');
    const view = deriveAppLoopView('plan-loop', { tiers: tiers(), repoDir });
    expect(view.epic).toBeUndefined();
  });

  it('carries no epic split mid-work (no verdict reached — not yet at the gate)', () => {
    plantEpic('plan-bundle-loop', true);
    writePlanArtifact(exampleEpicPlan(2));
    writeAppLoopState(repoDir, { loop: 'plan-bundle-loop', step: 'plan-bundle', turnKey: 'work-plan-bundle', status: 'working' }, FIXED);
    const view = deriveAppLoopView('plan-bundle-loop', { tiers: tiers(), repoDir });
    expect(view.epic).toBeUndefined();
  });
});

// §27.9.1 N9b.5(e) — `humanNeeded` reads the gate controller's state through the injected `autoGateViewFor`
// seam: a gate the engine is deciding is not human-needed, a hung accepted approve is, and a run the seam
// reports nothing for keeps today's view with no `autoGate` field (AC7).
describe('provideAppLoopView — per-step gate authority (§27.9.1)', () => {
  const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');
  const idle: FlowAutoGateView = { deciding: false, hung: false, haltReasons: [] };
  const engine = { activeRepoDir: () => repoDir, resume: () => {}, liveErrorFor: () => null };
  const seamFor = (step: string, turnKey: string, view: FlowAutoGateView): AutoGateViewFor =>
    (k, s, t) => (k === repoDir && s === step && t === turnKey ? view : undefined);

  it('a clean gate the engine is deciding is not human-needed and carries the seam\'s autoGate', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 1, verdict: 'clean' },
      FIXED,
    );
    const deciding = { ...idle, deciding: true };
    const view = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir }, seamFor('plan', 'consolidate-plan', deciding));
    expect(view.humanNeeded).toBe(false);
    expect(view.autoGate).toEqual(deciding);
  });

  it('an accepted run whose approve hung is human-needed', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'accepted' }, FIXED);
    const hung = { ...idle, hung: true };
    const view = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir }, seamFor('plan', 'consolidate-plan', hung));
    expect(view.humanNeeded).toBe(true);
    expect(view.autoGate).toEqual(hung);
  });

  it('an accepted run whose engine approve is still running its effects is not human-needed (negative pair)', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    writeAppLoopState(repoDir, { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'accepted' }, FIXED);
    const view = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir }, seamFor('plan', 'consolidate-plan', idle));
    expect(view.humanNeeded).toBe(false);
    expect(view.autoGate).toEqual(idle);
  });

  it('a run the seam reports nothing for carries no autoGate and keeps today\'s humanNeeded (AC7 pin)', () => {
    plant('plan-loop', ['approve', 'request-changes']);
    writeAppLoopState(
      repoDir,
      { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 1, verdict: 'clean' },
      FIXED,
    );
    const view = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir }, () => undefined);
    expect(view).not.toHaveProperty('autoGate');
    expect(view.humanNeeded).toBe(true);
  });

  describe('a run-state naming another loop (N9b.6(l))', () => {
    const foreign = (): void =>
      writeAppLoopState(
        repoDir,
        { loop: 'other-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 1, verdict: 'clean' },
        FIXED,
      );

    it('carries a halt the engine showed at that gate', () => {
      plant('plan-loop', ['approve', 'request-changes']);
      foreign();
      const halted = { ...idle, haltReasons: [{ reason: 'approve-not-persisted' as const, detail: 'the run-state names loop other-loop' }] };
      const view = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir }, seamFor('plan', 'consolidate-plan', halted));
      expect(view.autoGate).toEqual(halted);
      expect(view.humanNeeded).toBe(true);
    });

    it.each([
      ['the engine is still deciding', { ...idle, deciding: true }],
      ['the engine has shown no halt', idle],
    ] as const)('carries no autoGate and keeps the view\'s humanNeeded when %s', (_label, seamView) => {
      plant('plan-loop', ['approve', 'request-changes']);
      foreign();
      const without = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir });
      const view = provideAppLoopView(engine, 'plan-loop', { tiers: tiers(), repoDir }, seamFor('plan', 'consolidate-plan', seamView));
      expect(view).not.toHaveProperty('autoGate');
      expect(view.humanNeeded).toBe(without.humanNeeded);
    });
  });
});
