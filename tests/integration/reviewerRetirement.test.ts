import { reviewerCatalog } from '../helpers/reviewerCatalog';
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { reconcileRunReviewers, removeRunReviewers, runAgentsDir, runReviewersLoadedProblems, installedReviewerPath } from '../../src/main/runReviewers';
import { renderReviewerAgent, reviewerAgentName } from '../../src/main/reviewerAgents';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-retire-')); roots.push(root);
  const charter = join(root, 'charter.md'); writeFileSync(charter, 'Review this result.\n');
  const first = { loop: 'custom', persona: 'review-first', charter, tools: ['Bash'] };
  const second = { ...first, persona: 'review-second', tools: ['Read'] };
  const catalog = (reviewers = [first, second]) => reviewerCatalog(reviewers);
  expect(reconcileRunReviewers(root, catalog()).problems).toEqual([]);
  return { root, first, second, catalog, agents: runAgentsDir(root).dir };
}
it('reconciles changed tools and removed reviewers against the whole flow, preserving unrelated agents', () => {
  const { root, first, second, catalog, agents } = fixture();
  const old = installedReviewerPath(root, first);
  const current = { ...first, tools: ['Read'] };
  writeFileSync(join(agents, 'personal.md'), 'Personal agent');
  const foreign = installedReviewerPath(root, { ...first, persona: 'review-foreign' });
  writeFileSync(foreign, 'Foreign file');
  expect(reconcileRunReviewers(root, catalog([current, second])).problems).toEqual([]);
  expect.soft(existsSync(old)).toBe(false);
  expect.soft(existsSync(installedReviewerPath(root, second))).toBe(true);
  const before = Date.now() - 1;
  expect(reconcileRunReviewers(root, catalog([current])).problems).toEqual([]);
  expect.soft(existsSync(installedReviewerPath(root, second))).toBe(false);
  expect.soft(runReviewersLoadedProblems(root, [current], before).join('\n')).toMatch(/restart/i);
  expect.soft(readFileSync(join(agents, 'personal.md'), 'utf8')).toBe('Personal agent');
  expect(readFileSync(foreign, 'utf8')).toBe('Foreign file');
});
it('an empty whole-flow catalog removes installed reviewers', () => {
  const { root, agents } = fixture();
  expect(removeRunReviewers(root)).toEqual([]);
  expect(readdirSync(agents)).toEqual([]);
});
it('a broken catalog retains installed reviewers until correction and does not follow a planted cleanup-directory link', () => {
  const { root, agents } = fixture(); const files = readdirSync(agents);
  expect(reconcileRunReviewers(root, { reviewers: [], problems: ['invalid loop'] }).problems).toContain('invalid loop');
  expect(readdirSync(agents)).toEqual(files);
  const outside = mkdtempSync(join(tmpdir(), 'retire-outside-')); roots.push(outside);
  writeFileSync(join(outside, files[0]), readFileSync(join(agents, files[0])));
  rmSync(agents, { recursive: true }); symlinkSync(outside, agents);
  const problems = removeRunReviewers(root);
  expect.soft(problems.length).toBeGreaterThan(0);
  expect(existsSync(join(outside, files[0]))).toBe(true);
});
it.skipIf(process.getuid?.() === 0)('failed removal is reported and retry removes remaining reviewers', () => {
  const { root, agents } = fixture(); chmodSync(agents, 0o500);
  try {
    const failed = removeRunReviewers(root);
    expect.soft(failed.join('\n')).toContain(agents);
    expect.soft(readdirSync(agents)).toHaveLength(2);
  } finally { chmodSync(agents, 0o700); }
  expect(removeRunReviewers(root)).toEqual([]);
  expect(readdirSync(agents)).toEqual([]);
  expect(statSync(agents).isDirectory()).toBe(true);
});

it('retires app-generated names from the previous installer while preserving unmarked agents with the same filename shape', () => {
  const { root, first, agents, catalog } = fixture();
  const legacy = join(agents, 'custom--review-first.md');
  writeFileSync(legacy, renderReviewerAgent({ ...first, charter: 'Previous installer instructions.' }, reviewerAgentName(first.loop, first.persona)));
  writeFileSync(join(agents, 'custom--personal.md'), 'Personal agent, not generated');
  expect(reconcileRunReviewers(root, catalog()).problems).toEqual([]);
  expect.soft(existsSync(legacy)).toBe(false);
  expect(readFileSync(join(agents, 'custom--personal.md'), 'utf8')).toBe('Personal agent, not generated');
});

it.skipIf(process.getuid?.() === 0)('an unreadable obsolete reviewer is reported with a command whose repair lets Retry remove it', () => {
  const { root, first, second, catalog } = fixture();
  const obsolete = installedReviewerPath(root, second);
  chmodSync(obsolete, 0o000);
  try {
    const problems = reconcileRunReviewers(root, catalog([first])).problems.join('\n');
    expect.soft(problems).toContain(realpathSync(obsolete));
    const command = /```sh\n([\s\S]*?)```/.exec(problems)?.[1];
    expect(command, problems).toBeDefined();
    execFileSync('/bin/sh', ['-c', command!], { cwd: tmpdir(), stdio: 'pipe' });
    expect.soft(reconcileRunReviewers(root, catalog([first])).problems).toEqual([]);
    expect(existsSync(obsolete)).toBe(false);
  } finally { if (existsSync(obsolete)) chmodSync(obsolete, 0o600); }
});
