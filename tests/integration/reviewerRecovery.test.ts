import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { seedResolvedLoop } from '../helpers/resolvedReviewerFixture';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunReviewers, reviewerInstallNotice, runAgentsDir, runReviewerProblems, flowReviewers } from '../../src/main/runReviewers';
import { installedReviewerProblem, type InstalledReviewer } from '../../src/main/reviewerAgents';

let root: string;
let reviewer: InstalledReviewer;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reviewer recovery's $value-"));
  reviewer = { loop: 'custom-loop', persona: 'review-result', charter: join(root, 'charter.md'), tools: ['Read'] };
  writeFileSync(reviewer.charter, 'Resolved instructions.\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

it.each(['missing', 'directory'] as const)('source recovery identifies the correction and Retry: %s', (fault) => {
  ensureRunReviewers(root, [reviewer], '');
  if (fault === 'missing' || fault === 'directory') rmSync(reviewer.charter);
  if (fault === 'directory') mkdirSync(reviewer.charter);

  const failed = ensureRunReviewers(root, [reviewer], '');
  const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
  expect.soft(failed.problems.length).toBeGreaterThan(0);
  expect.soft(notice).toContain(reviewer.persona);
  expect.soft(notice).toContain(reviewer.charter);
  expect.soft(notice).toMatch(/restore|correct|repair|replace/i);
  expect.soft(notice).toMatch(/retry/i);
  expect.soft(runReviewerProblems(root, [reviewer], '', Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(0);

  if (fault === 'directory') rmSync(reviewer.charter, { recursive: true });
  writeFileSync(reviewer.charter, 'Repaired instructions.\n');
  reviewer.tools = ['Read'];
  expect.soft(ensureRunReviewers(root, [reviewer], '').problems).toEqual([]);
  expect(installedReviewerProblem(runAgentsDir(root), reviewer)).toBeNull();
});

function applyOfferedPermissionRepair(notice: string): void {
  const unrelated = join(root, 'unrelated');
  mkdirSync(unrelated);
  const sentinel = join(unrelated, 'private.txt');
  writeFileSync(sentinel, 'Unrelated private content.');
  chmodSync(unrelated, 0o700);
  chmodSync(sentinel, 0o600);
  const before = [statSync(unrelated).mode, statSync(sentinel).mode];
  expect.soft(notice).toMatch(/working directory|(?:run|execute)[^.\n]*(?:from|in)|any directory/i);
  expect.soft(notice).toMatch(/owner|privilege|permission|administrator|sudo|current user/i);
  const snippets = [...notice.matchAll(/```(?:sh|bash|shell)?\n([\s\S]*?)```|`([^`]+)`/g)].map((match) => match[1] ?? match[2]);
  const executable = /(?:^|[;&]\s*)(?:sudo\s+)?(?:cd|chmod|chown|setfacl)\s/;
  const fenced = /```(?:sh|bash|shell)?\n([\s\S]*?)```/.exec(notice)?.[1];
  const offered = fenced ?? snippets.find((snippet) => executable.test(snippet)) ?? notice.split('\n').find((line) => executable.test(line.trim()));
  expect.soft(offered).toBeDefined();
  let succeeded = true;
  try {
    const namedWorkingDirectory = notice.split(/\n|\. /).some((sentence) => /working directory|(?:run|execute)[^.\n]*(?:from|in)/i.test(sentence) && sentence.includes(root));
    execFileSync('/bin/sh', ['-c', offered ?? ':'], { cwd: namedWorkingDirectory ? root : unrelated, stdio: 'pipe' });
  } catch {
    succeeded = false;
  }
  expect.soft(succeeded).toBe(true);
  expect.soft([statSync(unrelated).mode, statSync(sentinel).mode]).toEqual(before);
  expect.soft(readFileSync(sentinel, 'utf8')).toBe('Unrelated private content.');
}

it.skipIf(process.getuid?.() === 0)('unreadable source names its reviewer and offers permission repair with Retry', () => {
  chmodSync(reviewer.charter, 0o000);
  try {
    const failed = ensureRunReviewers(root, [reviewer], '');
    const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
    expect.soft(failed.problems.length).toBeGreaterThan(0);
    expect.soft(notice).toContain(reviewer.persona);
    expect.soft(notice).toContain(reviewer.charter);
    expect.soft(notice).toMatch(/retry/i);
    applyOfferedPermissionRepair(notice);
    expect.soft(ensureRunReviewers(root, [reviewer], '').problems).toEqual([]);
    expect.soft(installedReviewerProblem(runAgentsDir(root), reviewer)).toBeNull();
  } finally {
    chmodSync(reviewer.charter, 0o600);
  }
});

it('retry reconciles seeded partial success without rewriting the successful reviewer', () => {
  ensureRunReviewers(root, [reviewer], '');
  const agents = runAgentsDir(root);
  const completed = join(agents.dir, readdirSync(agents.dir)[0]);
  utimesSync(completed, new Date(0), new Date(0));
  const bytes = readFileSync(completed);
  const mtime = statSync(completed).mtimeMs;
  const pending = { ...reviewer, persona: 'review-second', charter: join(root, 'second.md') };
  const failed = ensureRunReviewers(root, [reviewer, pending], '');
  const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
  expect.soft(failed.problems.length).toBeGreaterThan(0);
  expect.soft(notice).toContain(pending.persona);
  expect.soft(notice).toContain(pending.charter);
  expect.soft(notice).toMatch(/retry/i);
  writeFileSync(pending.charter, 'Second repaired instructions.\n');
  expect.soft(ensureRunReviewers(root, [reviewer, pending], '').problems).toEqual([]);
  expect.soft(readFileSync(completed)).toEqual(bytes);
  expect.soft(statSync(completed).mtimeMs).toBe(mtime);
  expect.soft(installedReviewerProblem(agents, reviewer)).toBeNull();
  expect(installedReviewerProblem(agents, pending)).toBeNull();
});

it('an exclusion conflict identifies the winning rule and reviewer, preserves gitignore, then recovers', () => {
  execFileSync('git', ['init', '-q', root]);
  const ignore = join(root, '.gitignore');
  const rule = '!.claude/agents/*.md\n';
  writeFileSync(ignore, rule);
  const failed = ensureRunReviewers(root, [reviewer], '');
  const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
  expect.soft(failed.problems.length).toBeGreaterThan(0);
  expect.soft(notice).toContain(reviewer.persona);
  expect.soft(notice).toContain('.gitignore');
  expect.soft(notice).toContain('!.claude/agents/*.md');
  expect.soft(notice).toMatch(/narrow|edit|remove|correct/);
  expect.soft(notice).toMatch(/retry/i);
  expect.soft(readFileSync(ignore, 'utf8')).toBe(rule);
  writeFileSync(ignore, 'build/\n');
  expect.soft(ensureRunReviewers(root, [reviewer], '').problems).toEqual([]);
  expect.soft(readFileSync(ignore, 'utf8')).toBe('build/\n');
  expect(execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', '.claude/agents'], { encoding: 'utf8' })).toBe('');
});

it.skipIf(process.getuid?.() === 0)('a nonwritable destination offers a repair that actually enables Retry', () => {
  const agents = runAgentsDir(root);
  mkdirSync(agents.dir, { recursive: true });
  const unrelatedAgent = join(agents.dir, 'personal.md');
  writeFileSync(unrelatedAgent, 'Unrelated installed instructions.\n', { mode: 0o640 });
  const unrelatedMode = statSync(unrelatedAgent).mode;
  chmodSync(agents.dir, 0o500);
  try {
    const failed = ensureRunReviewers(root, [reviewer], '');
    const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
    expect.soft(failed.problems.length).toBeGreaterThan(0);
    expect.soft(notice).toContain(reviewer.persona);
    expect.soft(notice).toContain(agents.dir);
    expect.soft(notice).toMatch(/retry/i);
    applyOfferedPermissionRepair(notice);
    expect.soft(ensureRunReviewers(root, [reviewer], '').problems).toEqual([]);
    expect.soft(installedReviewerProblem(agents, reviewer)).toBeNull();
    expect.soft(statSync(unrelatedAgent).mode).toBe(unrelatedMode);
    expect.soft(readFileSync(unrelatedAgent, 'utf8')).toBe('Unrelated installed instructions.\n');
  } finally {
    chmodSync(agents.dir, 0o700);
  }
});

it('known source refusal happens before creating any reviewer', () => {
  const missing = { ...reviewer, persona: 'review-missing', charter: join(root, 'missing.md') };
  const result = ensureRunReviewers(root, [reviewer, missing], '');
  expect.soft(result.problems.length).toBeGreaterThan(0);
  expect(result.wrote).toEqual([]);
});

it('an empty placeholder does not repair a missing charter or authorize a stale installed copy', () => {
  ensureRunReviewers(root, [reviewer], '');
  rmSync(reviewer.charter);
  expect.soft(ensureRunReviewers(root, [reviewer], '').problems.length).toBeGreaterThan(0);
  writeFileSync(reviewer.charter, '');
  expect.soft(ensureRunReviewers(root, [reviewer], '').problems.length).toBeGreaterThan(0);
  expect.soft(runReviewerProblems(root, [reviewer], '', Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(0);
  writeFileSync(reviewer.charter, 'Restored intended reviewer instructions.\n');
  expect.soft(ensureRunReviewers(root, [reviewer], '').problems).toEqual([]);
  expect(installedReviewerProblem(runAgentsDir(root), reviewer)).toBeNull();
});

it('the operator sees every outstanding reviewer, source and distinct cause', () => {
  const missing = { ...reviewer, persona: 'review-alpha', charter: join(root, 'alpha.md') };
  const invalid = { ...reviewer, persona: 'review-beta', tools: [], definitionFile: join(root, 'custom-loop.yaml') };
  const notice = reviewerInstallNotice(ensureRunReviewers(root, [missing, invalid], ''), 'claude-code') ?? '';
  expect.soft(notice).toContain(missing.persona);
  expect.soft(notice).toContain(missing.charter);
  expect.soft(notice).toMatch(/missing|no such file|not found|absent/i);
  expect.soft(notice).toContain(invalid.persona);
  expect.soft(notice).toContain(invalid.definitionFile);
  expect.soft(notice).toMatch(/no tools|empty.*tools|tools.*empty/i);
  expect(notice).toMatch(/retry/i);
});

it('invalid tools identify the real loop definition to correct before Retry', () => {
  const tier = join(root, 'loops');
  const file = seedResolvedLoop(tier, 'custom', 'Valid charter.\n', []);
  const install = () => ensureRunReviewers(root, flowReviewers([{ kind: 'loop', loop: 'custom' }], (name) => resolveLoopDefV2(name, {
    repoDir: root, tiers: { operator: tier, appBundled: join(root, 'absent'), retired: null },
  })), '');
  const failed = install();
  const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
  expect.soft(notice).toContain(file);
  expect.soft(notice).toContain('review-result');
  expect.soft(notice).toMatch(/tools/);
  expect.soft(notice).toMatch(/correct|repair/i);
  expect.soft(notice).toMatch(/retry/i);
  expect(failed.wrote).toEqual([]);
  seedResolvedLoop(tier, 'custom', 'Valid charter.\n', ['Read']);
  expect(install().problems).toEqual([]);
});
