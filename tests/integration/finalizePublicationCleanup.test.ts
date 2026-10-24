import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAppGateGitHub } from '../../src/main/appGateGithub';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  rm: vi.fn(),
}));

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([false, true])('keeps publication outcome independent of cleanup failure (publication fails: %s)', async (fails) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-cleanup-test-'));
  dirs.push(dir);
  const artifact = join(dir, 'audit.md');
  writeFileSync(artifact, '# Audit\n');
  const cleanupError = new Error('cleanup denied');
  const publicationError = new Error('publication rejected');
  vi.mocked(fs.rm).mockRejectedValue(cleanupError);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let body = 'Description\n';
  const run = createAppGateGitHub({
    pullRequest: async () => { throw new Error('unused'); },
    pullRequestBody: async () => body,
    markPullRequestReady: async () => { throw new Error('unused'); },
    updateIssueBody: async () => { throw new Error('unused'); },
    publishPullRequestBody: async (_number, file) => {
      dirs.push(dirname(file));
      if (fails) throw publicationError;
      body = await fs.readFile(file, 'utf8');
    },
  });
  const result = run('publish-flow-audit', { pr: 41, ticket: 251, bodyFile: artifact, bootstrap: null });
  if (fails) await expect(result).rejects.toBe(publicationError);
  else await expect(result).resolves.toEqual({ outcome: 'done' });
  expect(warning.mock.calls.flat().join(' ')).toContain('cleanup denied');
});
