import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunReviewers, reviewerInstallNotice, runAgentsDir } from '../../src/main/runReviewers';
import { resolvedReviewerFile } from '../../src/main/resolvedReviewer';
import type { InstalledReviewer } from '../../src/main/reviewerAgents';

let root: string;
let reviewer: InstalledReviewer;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "reviewer safety's $value-"));
  reviewer = { loop: 'custom', persona: 'review-result', charter: join(root, 'charter.md'), tools: ['Read'] };
  writeFileSync(reviewer.charter, 'Intended charter.\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('refuses invalid UTF-8 in a charter instead of installing replacement characters', () => {
  writeFileSync(reviewer.charter, Buffer.from([0xff]));
  const result = ensureRunReviewers(root, [reviewer], '');
  expect(result.wrote).toEqual([]);
  expect(result.problems.join(' ')).toContain(reviewer.charter);
});

it('refuses a known invalid destination before writing another reviewer', () => {
  const other = { ...reviewer, persona: 'review-other' };
  const blocked = join(runAgentsDir(root).dir, resolvedReviewerFile(other));
  mkdirSync(blocked, { recursive: true });
  const result = ensureRunReviewers(root, [reviewer, other], '');
  expect(result.wrote).toEqual([]);
  expect(result.problems.join(' ')).toContain(blocked);
});

it.skipIf(process.getuid?.() === 0).each(['exclude', 'agents-parent', 'source-parent'] as const)('offered repair fixes the actual permission obstruction: %s', (fault) => {
  execFileSync('git', ['init', '-q', root]);
  let obstruction: string;
  if (fault === 'exclude') {
    obstruction = join(root, '.git/info/exclude');
    chmodSync(obstruction, 0o400);
  } else if (fault === 'agents-parent') {
    obstruction = join(root, '.claude');
    mkdirSync(obstruction);
    chmodSync(obstruction, 0o500);
  } else {
    obstruction = join(root, 'sources');
    mkdirSync(obstruction);
    reviewer.charter = join(obstruction, 'charter.md');
    writeFileSync(reviewer.charter, 'Intended charter.\n');
    chmodSync(obstruction, 0o600);
  }
  try {
    const failed = ensureRunReviewers(root, [reviewer], '');
    const notice = reviewerInstallNotice(failed, 'claude-code') ?? '';
    expect.soft(failed.problems.length).toBeGreaterThan(0);
    const command = /```sh\n([\s\S]*?)```/.exec(notice)?.[1];
    expect.soft(command).toBeDefined();
    expect.soft(notice).toContain(obstruction);
    let repaired = true;
    try { execFileSync('/bin/sh', ['-c', command ?? ':'], { cwd: tmpdir(), stdio: 'pipe' }); } catch { repaired = false; }
    expect.soft(repaired).toBe(true);
    expect(ensureRunReviewers(root, [reviewer], '').problems).toEqual([]);
    expect(readFileSync(join(runAgentsDir(root).dir, resolvedReviewerFile(reviewer)), 'utf8')).toContain('Intended charter.');
  } finally {
    chmodSync(obstruction, fault === 'exclude' ? 0o600 : 0o700);
  }
});

it('preserves a charter byte-order mark and accepts the installed reviewer without rewriting it', () => {
  const charter = '\uFEFFIntended charter.\n';
  writeFileSync(reviewer.charter, charter);
  const result = ensureRunReviewers(root, [reviewer], '');
  expect(result.problems).toEqual([]);
  expect(readFileSync(join(runAgentsDir(root).dir, resolvedReviewerFile(reviewer)), 'utf8')).toContain(`---\n${charter}`);
  expect(ensureRunReviewers(root, [reviewer], '').wrote).toEqual([]);
});
