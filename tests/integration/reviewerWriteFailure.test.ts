import { reviewerCatalog } from '../helpers/reviewerCatalog';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRunReviewers, reviewerInstallNotice, runAgentsDir } from '../../src/main/runReviewers';
import { installedReviewerProblem, type InstalledReviewer } from '../../src/main/reviewerAgents';

const fault = vi.hoisted(() => ({ dir: '', code: '', completed: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => {
      if (fault.code && String(to).startsWith(fault.dir) && fault.completed > 0) {
        throw Object.assign(new Error(`${fault.code}: fixture write failure`), { code: fault.code });
      }
      fs.renameSync(from, to);
      if (String(to).startsWith(fault.dir)) fault.completed++;
    },
  };
});
let root: string;
let reviewers: InstalledReviewer[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewer-write-failure-'));
  reviewers = ['review-first', 'review-second'].map((persona) => {
    const charter = join(root, `${persona}.md`);
    writeFileSync(charter, `${persona} instructions.\n`);
    return { loop: 'custom-loop', persona, charter, tools: ['Read'] };
  });
  mkdirSync(runAgentsDir(root).dir, { recursive: true });
  fault.dir = `${realpathSync(runAgentsDir(root).dir)}/`;
  fault.completed = 0;
  fault.code = '';
});
afterEach(() => { fault.code = ''; rmSync(root, { recursive: true, force: true }); });

it.each(['ENOSPC', 'EIO'] as const)('a late %s failure diagnoses the outstanding reviewer and retry retains successful writes', (code) => {
  const agents = runAgentsDir(root);
  mkdirSync(agents.dir, { recursive: true });
  writeFileSync(join(agents.dir, 'personal.md'), 'Unrelated local instructions.');
  fault.code = code;
  const failed = reconcileRunReviewers(root, reviewerCatalog(reviewers));
  const completed = readdirSync(agents.dir).filter((file) => file !== 'personal.md');
  const bytes = completed.map((file) => [file, readFileSync(join(agents.dir, file), 'utf8')] as const);
  const outstanding = reviewers.filter((reviewer) => installedReviewerProblem(agents, reviewer) !== null);
  expect.soft(completed).toHaveLength(1);
  expect.soft(outstanding).toHaveLength(1);
  const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
  expect.soft(notice).toContain(outstanding[0]?.persona ?? 'missing outstanding reviewer');
  expect.soft(notice).toContain(agents.dir);
  expect.soft(notice).toContain(code);
  expect.soft(notice).toMatch(/retry/i);
  if (code === 'ENOSPC') expect.soft(notice).toMatch(/free.*space|space.*free/i);
  const repeated = reconcileRunReviewers(root, reviewerCatalog(reviewers));
  expect.soft(repeated.problems.length).toBeGreaterThan(0);
  expect.soft(reviewerInstallNotice(repeated, 'claude-code')).toMatch(/retry/i);
  fault.code = '';
  expect.soft(reconcileRunReviewers(root, reviewerCatalog(reviewers)).problems).toEqual([]);
  for (const [file, content] of bytes) expect.soft(readFileSync(join(agents.dir, file), 'utf8')).toBe(content);
  for (const reviewer of reviewers) expect.soft(installedReviewerProblem(agents, reviewer)).toBeNull();
  expect(readFileSync(join(agents.dir, 'personal.md'), 'utf8')).toBe('Unrelated local instructions.');
});
