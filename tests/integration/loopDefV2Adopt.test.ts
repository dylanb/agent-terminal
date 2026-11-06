import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Result } from '../../src/main/loopDefV2';

const defWithPickup = (pickup: string): string => `version: v2
name: review-loop
work:
  recipe: prompts/work.md
  artifact: report
reviewers: []
boundaries: []
report:
  sections: [summary]
gate:
  - option: approve
${pickup}outputs:
  - id: report
    path: review-report.md
`;

let root: string;
let repoDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v2-adopt-tier-'));
  repoDir = mkdtempSync(join(tmpdir(), 'v2-adopt-repo-'));
});
afterEach(() => {
  for (const d of [root, repoDir]) rmSync(d, { recursive: true, force: true });
});

function resolveWith(pickup: string): LoopDefV2Result {
  const defDir = join(root, 'review-loop');
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'review the pull request\n');
  writeFileSync(join(defDir, 'review-loop.yaml'), defWithPickup(pickup));
  return resolveLoopDefV2('review-loop', { tiers: { operator: null, appBundled: root, retired: null }, repoDir });
}

const outcome = (r: LoopDefV2Result): string => (r.ok ? 'loaded' : r.reason);

describe('resolveLoopDefV2 — the adopt form of pickup (#304 AC 1)', () => {
  it('loads a def whose pickup adopts the pull request its pr input names', () => {
    expect(outcome(resolveWith('pickup:\n  adopt: pr\n'))).toBe('loaded');
  });

  it('still loads the ticket form beside it', () => {
    expect(outcome(resolveWith('pickup:\n  initial_status: planning\n  branch_template: plan-loop/issue-{issue}\n'))).toBe('loaded');
  });

  it.each([
    ['initial_status', '  initial_status: planning\n'],
    ['branch_template', '  branch_template: plan-loop/issue-{issue}\n'],
    ['initial_labels', '  initial_labels: []\n'],
    ['on_conflict', '  on_conflict: abort\n'],
    ['stray_key', '  stray_key: 1\n'],
  ])('fails an adopt form that also carries %s, naming that key', (key, line) => {
    const r = resolveWith(`pickup:\n  adopt: pr\n${line}`);
    expect(r.ok).toBe(false);
    expect(outcome(r)).toContain(key);
  });

  it('fails an adopt form that adopts anything but pr, naming adopt', () => {
    const r = resolveWith('pickup:\n  adopt: ticket\n');
    expect(r.ok).toBe(false);
    expect(outcome(r)).toContain('adopt');
  });
});
