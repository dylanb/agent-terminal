import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureRunReviewers } from '../../src/main/runReviewers';

for (const fault of ['destination', 'source'] as const) {
  test(`administrator repair enables a different owner to retry reviewer ${fault}`, { tag: '@ownapp' }, () => {
    test.skip(process.getuid?.() !== 0 || process.seteuid === undefined, 'Requires the disposable root Podman environment.');
    const operator = 1001;
    const root = mkdtempSync(join(tmpdir(), "reviewer owner's-"));
    const charter = join(root, 'charter.md');
    writeFileSync(charter, 'Required reviewer instructions.\n');
    chownSync(root, operator, operator);
    if (fault === 'destination') {
      const claude = join(root, '.claude');
      mkdirSync(join(claude, 'agents'), { recursive: true, mode: 0o755 });
      chownSync(claude, operator, operator);
    } else chmodSync(charter, 0o000);
    const installAsOperator = () => {
      process.seteuid!(operator);
      try {
        return ensureRunReviewers(root, [{ loop: 'custom', persona: 'review-result', charter, tools: ['Read'] }], '');
      } finally {
        process.seteuid!(0);
      }
    };
    try {
      const failed = installAsOperator();
      expect(failed.wrote).toEqual([]);
      const notice = failed.problems.join('\n');
      expect(notice).toMatch(/administrator|root/i);
      const command = /```sh\n([\s\S]*?)```/.exec(notice)?.[1];
      expect(command).toBeDefined();
      execFileSync('/bin/sh', ['-c', command!], { cwd: tmpdir(), stdio: 'pipe' });
      const repaired = installAsOperator();
      expect(repaired.problems).toEqual([]);
      expect(repaired.wrote).toHaveLength(1);
      expect(readFileSync(repaired.wrote[0], 'utf8')).toContain('Required reviewer instructions.');
    } finally {
      process.seteuid!(0);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
