import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAppLoopView } from '../../src/main/loopViewV2';
import type { LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { writeAppLoopState } from '../../src/main/appLoopState';

// The §27 loop-view provider (the READ meeting point, engine-selected on the flow step's `app` namespace):
// it resolves the bound app-def and produces the whole loop view the strip/panel render — a run-less view
// (gate options display-only, no round has run) or a def-failure view carrying the reason (AC 6). It reads
// no §26 loop state, so a §27 step renders with §26 defs and §26 loop state absent (AC "neither path").

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
  return { operator: null, appBundled: join(appDir, 'loops-v2') };
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
