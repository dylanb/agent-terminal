import { reviewerCatalog } from '../helpers/reviewerCatalog';
import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRunReviewers, runAgentsDir, installedReviewerPath } from '../../src/main/runReviewers';
import { installedReviewerProblem } from '../../src/main/reviewerAgents';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('replaces a required destination without changing the unrelated local agent an in-folder link targets', () => {
  const run = mkdtempSync(join(tmpdir(), 'reviewer-destination-'));
  roots.push(run);
  const charter = join(run, 'charter.md');
  writeFileSync(charter, 'Resolved instructions.\n');
  const reviewer = { loop: 'custom-loop', persona: 'review-result', charter, tools: 'all' as const };
  const agents = runAgentsDir(run);
  mkdirSync(agents.dir, { recursive: true });
  const unrelated = join(agents.dir, 'personal.md');
  writeFileSync(unrelated, 'Keep my agent.\n');
  symlinkSync(unrelated, installedReviewerPath(run, reviewer));

  const result = reconcileRunReviewers(run, reviewerCatalog([reviewer]));

  expect(readFileSync(unrelated, 'utf8')).toBe('Keep my agent.\n');
  expect(result.problems).toEqual([]);
  expect(installedReviewerProblem(agents, reviewer)).toBeNull();
});

it.skipIf(process.getuid?.() === 0)('replaces a required destination that is writable but cannot be read', () => {
  const run = mkdtempSync(join(tmpdir(), 'write-only-reviewer-'));
  roots.push(run);
  const charter = join(run, 'charter.md');
  writeFileSync(charter, 'Resolved instructions.\n');
  const reviewer = { loop: 'custom-loop', persona: 'review-result', charter, tools: 'all' as const };
  const agents = runAgentsDir(run);
  mkdirSync(agents.dir, { recursive: true });
  const destination = installedReviewerPath(run, reviewer);
  writeFileSync(destination, 'Foreign agent.\n');
  chmodSync(destination, 0o200);

  const result = reconcileRunReviewers(run, reviewerCatalog([reviewer]));

  expect(result.problems).toEqual([]);
  expect(installedReviewerProblem(agents, reviewer)).toBeNull();
});
