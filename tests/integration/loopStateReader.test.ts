import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { readLoopExtension } from '../../src/main/loopStateReader';

// §26.6 — the orchestrator reads back the engine-extension fields it writes (cap_baseline, the §26.8
// impasse tracking, the §26.5 persona_state), which are NOT part of the §24.2.3 mirror slice. This reader
// degrades every missing/ill-typed field to its default so a foreign or partial state.yaml is safe.
describe('loop state.yaml extension reader (§26.6)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopread-'));
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const write = (doc: Record<string, unknown>): void =>
    writeFileSync(join(repo, '.agent-loop', 'state.yaml'), yaml.dump({ schema_version: 4, ...doc }));

  it('reads cap_baseline back as written', () => {
    write({ status: 'plan-draft', iteration: 5, cap_baseline: 3 });
    expect(readLoopExtension(repo).capBaseline).toBe(3);
  });

  it('defaults cap_baseline to 0 when the field is absent or ill-typed', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).capBaseline).toBe(0);
    write({ status: 'plan-draft', iteration: 1, cap_baseline: 'nope' });
    expect(readLoopExtension(repo).capBaseline).toBe(0);
  });

  // CWE-20/770 — .agent-loop/state.yaml is attacker-plantable repo content, and cap_baseline feeds the
  // §26.8 runaway backstop (`iteration - cap_baseline >= cap`). A malformed numeric — negative, NaN, ±Inf,
  // or a non-integer — must degrade to 0 (the safe "window == monotonic iteration" default) rather than
  // reach the subtraction. (An in-range-typed but out-of-range value — cap_baseline > iteration — is
  // clamped at the decision, where `iteration` is known: see decideConsolidateOutcome's own test.)
  it('rejects a malformed numeric cap_baseline (negative, NaN, Infinity, or non-integer) down to 0', () => {
    for (const hostile of [-1, -1e9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.5]) {
      write({ status: 'plan-draft', iteration: 1, cap_baseline: hostile });
      expect(readLoopExtension(repo).capBaseline).toBe(0);
    }
  });

  it('reads the §26.8 impasse tracking back as written', () => {
    write({ status: 'plan-draft', iteration: 2, impasse: { consecutive_identical: 2, last_findings_sig: 'sigA' } });
    expect(readLoopExtension(repo).impasse).toEqual({ consecutiveIdentical: 2, lastFindingsSig: 'sigA' });
  });

  it('defaults the impasse tracking to a zero run + empty signature when absent or ill-typed', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).impasse).toEqual({ consecutiveIdentical: 0, lastFindingsSig: '' });
  });

  it('reads the §26.5 persona_state footprints back as written', () => {
    write({
      status: 'plan-draft',
      iteration: 2,
      persona_state: { 'review-principal': { last_clean_iter: 1, last_seen_plan_digest: 'D', last_seen_files: ['a.ts'] } },
    });
    expect(readLoopExtension(repo).personaState).toEqual({
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: 'D', lastSeenFiles: ['a.ts'] },
    });
  });

  it('defaults each persona_state entry field a partial map omits', () => {
    write({ status: 'plan-draft', iteration: 2, persona_state: { 'review-security': { last_clean_iter: 3 } } });
    expect(readLoopExtension(repo).personaState).toEqual({
      'review-security': { lastCleanIter: 3, lastSeenPlanDigest: '', lastSeenFiles: [] },
    });
  });

  it('defaults persona_state to an empty map when absent', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).personaState).toEqual({});
  });

  // §26.10 — the display-only per-iteration cost persisted at the iteration boundary (usd + unpriced ids).
  it('reads the §26.10 cost back as written', () => {
    write({ status: 'plan-draft', iteration: 2, cost: { usd: 0.42, unpriced: ['x-unknown'] } });
    expect(readLoopExtension(repo).cost).toEqual({ usd: 0.42, unpricedModels: ['x-unknown'] });
  });

  it('defaults an unpriced list a partial cost omits, and drops non-string entries', () => {
    write({ status: 'plan-draft', iteration: 2, cost: { usd: 1.5 } });
    expect(readLoopExtension(repo).cost).toEqual({ usd: 1.5, unpricedModels: [] });
  });

  it('defaults cost to null when absent or ill-typed (no cost recorded yet)', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).cost).toBeNull();
    write({ status: 'plan-draft', iteration: 1, cost: { usd: 'nope' } });
    expect(readLoopExtension(repo).cost).toBeNull();
  });

  // §26.11 — resume reads which LoopDef governs the interrupted run from state.yaml's bound_loop.
  it('reads the bound_loop back as written (§26.11 resume)', () => {
    write({ status: 'plan-draft', iteration: 1, bound_loop: 'plan-loop' });
    expect(readLoopExtension(repo).boundLoop).toBe('plan-loop');
  });

  it('defaults bound_loop to "" when absent or ill-typed', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).boundLoop).toBe('');
  });

  // §26.9 — epic-promote records the created sub-issue numbers; resume/the gate read them back to stay
  // idempotent (never re-create an already-promoted epic).
  it('reads epic.sub_issues back as written', () => {
    write({ status: 'plan-draft', iteration: 1, epic: { sub_issues: [101, 102] } });
    expect(readLoopExtension(repo).epic).toEqual({ subIssues: [101, 102] });
  });

  it('defaults epic.subIssues to [] when absent or ill-typed', () => {
    write({ status: 'plan-draft', iteration: 1 });
    expect(readLoopExtension(repo).epic).toEqual({ subIssues: [] });
    write({ status: 'plan-draft', iteration: 1, epic: { sub_issues: 'nope' } });
    expect(readLoopExtension(repo).epic).toEqual({ subIssues: [] });
  });

  it('defaults to a safe extension for a missing or unreadable state.yaml (never throws)', () => {
    rmSync(join(repo, '.agent-loop'), { recursive: true, force: true });
    expect(readLoopExtension(repo)).toEqual({
      capBaseline: 0,
      impasse: { consecutiveIdentical: 0, lastFindingsSig: '' },
      personaState: {},
      cost: null,
      boundLoop: '',
      epic: { subIssues: [] },
    });
  });
});
