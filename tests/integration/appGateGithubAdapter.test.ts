import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealAppGateGitHub } from '../../src/main/appGateGithub';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalMarker = process.env.FAKE_READY_MARKER;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalMarker === undefined) delete process.env.FAKE_READY_MARKER;
  else process.env.FAKE_READY_MARKER = originalMarker;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('real app gate GitHub adapter', () => {
  it('refuses a same-number closing issue from another repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'app-gate-github-'));
    const bin = mkdtempSync(join(tmpdir(), 'app-gate-github-bin-'));
    const marker = join(bin, 'ready');
    cleanup.push(repo, bin);
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://github.com/owner/repository.git',
      ],
      { cwd: repo },
    );
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\\n\' \'{"number":42,"url":"https://github.com/owner/repository/pull/42","headRefName":"plan-loop/issue-78","state":"OPEN","closingIssuesReferences":[{"number":78,"url":"https://github.com/other/repository/issues/78"}]}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "ready" ]; then touch "$FAKE_READY_MARKER"; exit 0; fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.FAKE_READY_MARKER = marker;

    await expect(
      createRealAppGateGitHub(repo)('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        bootstrap: {
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
          initialStatus: 'planning',
        },
      }),
    ).rejects.toThrow(/bootstrap PR identity/i);
    expect(existsSync(marker)).toBe(false);
  });
});
