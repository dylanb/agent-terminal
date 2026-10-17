import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';

// §27.3 (v2.201) — a goal work turn may run in legs: `work.checkpoint.passes` is how many review passes a leg
// runs before the session saves its progress and the engine compacts and starts the next leg.

function def(work: string): string {
  return (
    'version: v2\n' +
    'name: green-loop\n' +
    `work:\n  recipe: prompts/work.md\n  artifact: commits\n${work}` +
    'reviewers:\n  - persona: impl-review-tests\n    charter: charter/tests.md\n' +
    'boundaries:\n  - boundary: pre-work\n    mode: clear\n' +
    'report:\n  sections: [summary]\n' +
    'gate:\n  - option: approve\n  - option: redo\n'
  );
}

const GOAL = '  goal: "the latest review pass returned no findings to fix"\n';

let appDir: string;
let repoDir: string;

function resolve(body: string): LoopDefV2Result {
  const defDir = join(appDir, 'green-loop');
  mkdirSync(join(defDir, 'charter'), { recursive: true });
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'charter', 'tests.md'), '# tests\n');
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(defDir, 'green-loop.yaml'), body);
  return resolveLoopDefV2('green-loop', { tiers: { operator: null, appBundled: appDir, retired: null }, repoDir });
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'v2-checkpoint-app-'));
  repoDir = mkdtempSync(join(tmpdir(), 'v2-checkpoint-repo-'));
});
afterEach(() => {
  for (const d of [appDir, repoDir]) rmSync(d, { recursive: true, force: true });
});

describe('a goal work turn declares how many review passes each leg runs (§27.3 v2.201)', () => {
  it('reads the passes per leg', () => {
    const r = resolve(def(`${GOAL}  checkpoint:\n    passes: 3\n`));
    expect(r.ok && r.def.work.checkpoint).toEqual({ passes: 3 });
  });

  it('a goal def without a checkpoint runs in one leg', () => {
    const r = resolve(def(GOAL));
    expect(r.ok && r.def.work.checkpoint).toBeUndefined();
  });

  it.each([['0'], ['-1'], ['2.5'], ['"3"']])('refuses %s passes', (passes) => {
    const r = resolve(def(`${GOAL}  checkpoint:\n    passes: ${passes}\n`));
    expect(r.ok ? '' : r.reason).toContain('work checkpoint passes must be a positive whole number');
  });

  it('refuses a checkpoint on a work turn that has no goal', () => {
    const body = def('  checkpoint:\n    passes: 3\n').replace(/reviewers:\n.*\n.*\n/, 'reviewers: []\n');
    const r = resolve(body);
    expect(r.ok ? '' : r.reason).toContain('a work checkpoint needs a work goal');
  });
});
