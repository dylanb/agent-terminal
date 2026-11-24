import { reviewerCatalog } from '../helpers/reviewerCatalog';
import { test, expect } from '@playwright/test';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileRunReviewers } from '../../src/main/runReviewers';

for (const fault of ['destination', 'source', 'shared-ancestor', 'replaced-source'] as const) {
  test(`administrator repair enables a different owner to retry reviewer ${fault}`, { tag: '@ownapp' }, () => {
    test.skip(process.getuid?.() !== 0 || process.seteuid === undefined, 'Requires the disposable root Podman environment.');
    const operator = 1001;
    const root = mkdtempSync(join(tmpdir(), "reviewer owner's-"));
    let charter = join(root, 'charter.md');
    writeFileSync(charter, 'Required reviewer instructions.\n');
    chownSync(root, operator, operator);
    if (fault === 'destination') {
      const claude = join(root, '.claude');
      mkdirSync(join(claude, 'agents'), { recursive: true, mode: 0o755 });
      chownSync(claude, operator, operator);
    } else if (fault === 'shared-ancestor') {
      const shared = join(root, 'shared'); mkdirSync(shared, { mode: 0o700 });
      charter = join(shared, 'charter.md'); writeFileSync(charter, 'Required reviewer instructions.\n');
      writeFileSync(join(shared, 'unrelated.txt'), 'Unrelated');
    } else chmodSync(charter, 0o000);
    const installAsOperator = () => {
      process.seteuid!(operator);
      try {
        return reconcileRunReviewers(root, reviewerCatalog([{ loop: 'custom', persona: 'review-result', charter, tools: ['Read'] }]));
      } finally {
        process.seteuid!(0);
      }
    };
    try {
      const failed = installAsOperator();
      expect(failed.wrote).toEqual([]);
      const notice = failed.problems.join('\n');
      expect(notice).toMatch(/administrator|root|access/i);
      const command = /```sh\n([\s\S]*?)```/.exec(notice)?.[1];
      expect.soft(command).toBeUndefined();
      expect.soft(notice).not.toMatch(/\bchown\s/);
      const target = fault === 'destination' ? join(root, '.claude', 'agents') : fault === 'shared-ancestor' ? join(root, 'shared') : charter;
      const owner = statSync(target).uid;
      if (fault === 'replaced-source') {
        const outside = join(root, 'outside-sentinel'); writeFileSync(outside, 'Sentinel', { mode: 0o000 });
        renameSync(charter, charter + '.original'); symlinkSync(outside, charter);
        expect(statSync(outside).uid).toBe(0);
        expect(statSync(outside).mode & 0o777).toBe(0);
        rmSync(charter); renameSync(charter + '.original', charter);
      }
      // The administrator chooses access appropriate for this disposable fixture, retaining ownership.
      chmodSync(target, fault === 'destination' ? 0o777 : fault === 'shared-ancestor' ? 0o755 : 0o644);
      expect(statSync(target).uid).toBe(owner);
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
