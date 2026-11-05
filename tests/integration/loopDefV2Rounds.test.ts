import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';
import { GOAL_CONDITION_MAX_CHARS } from '../../src/shared/engineCapabilities/loop';

// §27.3/§27.8 — whether a loop runs engine review rounds is decided by its def: a consolidator means
// review-and-fix rounds judged by it; no consolidator means the work turn goes straight to the gate. A goal
// work turn (`work.goal`) runs its declared reviewers itself, so it never has engine rounds.

const REVIEWER = `  - persona: review-plan-intent
    charter: charter/intent.md
`;

function def(opts: { reviewers?: string; consolidator?: boolean; goal?: string; gate?: string[] }): string {
  const reviewers = opts.reviewers === undefined ? 'reviewers: []\n' : `reviewers:\n${opts.reviewers}`;
  const gate = (opts.gate ?? ['approve', 'redo']).map((o) => `  - option: ${o}\n`).join('');
  return (
    'version: v2\n' +
    'name: groom-goal-loop\n' +
    'work:\n  recipe: prompts/work.md\n  artifact: groomed-ticket\n' +
    (opts.goal !== undefined ? `  goal: ${JSON.stringify(opts.goal)}\n` : '') +
    reviewers +
    (opts.consolidator ? 'consolidator:\n  recipe: prompts/consolidate.md\n' : '') +
    'boundaries:\n  - boundary: pre-work\n    mode: clear\n' +
    'report:\n  sections: [summary, findings, disposition]\n' +
    `gate:\n${gate}` +
    'outputs:\n  - id: groomed-ticket\n    path: groomed-ticket.md\n'
  );
}

let appDir: string;
let repoDir: string;

function resolve(body: string): LoopDefV2Result {
  const defDir = join(appDir, 'groom-goal-loop');
  mkdirSync(join(defDir, 'charter'), { recursive: true });
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'charter', 'intent.md'), '# intent\n');
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(defDir, 'prompts', 'consolidate.md'), 'judge\n');
  writeFileSync(join(defDir, 'groom-goal-loop.yaml'), body);
  return resolveLoopDefV2('groom-goal-loop', { tiers: { operator: null, appBundled: appDir, retired: null }, repoDir });
}

function reason(r: LoopDefV2Result): string {
  return r.ok ? '' : r.reason;
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'v2-rounds-app-'));
  repoDir = mkdtempSync(join(tmpdir(), 'v2-rounds-repo-'));
});
afterEach(() => {
  for (const d of [appDir, repoDir]) rmSync(d, { recursive: true, force: true });
});

describe('a loop def decides whether the engine runs review rounds (§27.8)', () => {
  it('a def with reviewers and a consolidator runs engine rounds judged by that consolidator', () => {
    const r = resolve(def({ reviewers: REVIEWER, consolidator: true, gate: ['approve', 'request-changes'] }));
    expect(r.ok, reason(r)).toBe(true);
    if (!r.ok) return;
    expect(r.def.rounds).toEqual({ kind: 'engine', consolidator: realpathSync(join(appDir, 'groom-goal-loop', 'prompts', 'consolidate.md')) });
  });

  it('a def with no reviewers and no consolidator runs no review rounds', () => {
    const r = resolve(def({}));
    expect(r.ok, reason(r)).toBe(true);
    if (!r.ok) return;
    expect(r.def.rounds).toEqual({ kind: 'none' });
  });

  it('refuses reviewers with no consolidator and no goal: nothing would ever run them', () => {
    const r = resolve(def({ reviewers: REVIEWER }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/reviewers.*consolidator/);
  });

  it('refuses request-changes on a loop with no review rounds: it re-enters a round that does not exist', () => {
    const r = resolve(def({ gate: ['approve', 'request-changes'] }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/request-changes/);
  });
});

describe('a goal work turn (§27.3)', () => {
  const GOAL = 'the latest review pass on the groomed ticket returned no findings';

  it('carries its condition and its reviewers, and runs no engine rounds', () => {
    const r = resolve(def({ goal: GOAL, reviewers: REVIEWER }));
    expect(r.ok, reason(r)).toBe(true);
    if (!r.ok) return;
    expect(r.def.work.goal).toBe(GOAL);
    expect(r.def.reviewers.map((x) => x.persona)).toEqual(['review-plan-intent']);
    expect(r.def.rounds).toEqual({ kind: 'none' });
  });

  it('refuses a goal beside a consolidator: the goal session runs the reviews itself', () => {
    const r = resolve(def({ goal: GOAL, reviewers: REVIEWER, consolidator: true }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/goal.*consolidator/);
  });

  it('refuses a blank goal', () => {
    const r = resolve(def({ goal: '   ' }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/goal/);
  });

  it('refuses a goal spanning more than one line: it is submitted as one command line', () => {
    const r = resolve(def({ goal: 'first line\nsecond line' }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/goal.*one line/);
  });

  it(`refuses a goal longer than ${GOAL_CONDITION_MAX_CHARS} characters`, () => {
    expect(resolve(def({ goal: 'x'.repeat(GOAL_CONDITION_MAX_CHARS) })).ok).toBe(true);
    const r = resolve(def({ goal: 'x'.repeat(GOAL_CONDITION_MAX_CHARS + 1) }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toMatch(/goal.*characters/);
  });
});
