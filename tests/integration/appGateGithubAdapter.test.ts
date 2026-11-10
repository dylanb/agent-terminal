import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
const originalEditMarker = process.env.FAKE_EDIT_MARKER;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalMarker === undefined) delete process.env.FAKE_READY_MARKER;
  else process.env.FAKE_READY_MARKER = originalMarker;
  if (originalEditMarker === undefined) delete process.env.FAKE_EDIT_MARKER;
  else process.env.FAKE_EDIT_MARKER = originalEditMarker;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function seedRepoWithGh(prefix: string, script: string): {
  repo: string;
  bin: string;
} {
  const repo = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const bin = mkdtempSync(join(tmpdir(), `${prefix}-bin-`));
  cleanup.push(repo, bin);
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'],
    { cwd: repo },
  );
  writeFileSync(join(bin, 'gh'), script, { mode: 0o755 });
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return { repo, bin };
}

describe('real app gate GitHub adapter', () => {
  it('refuses to replace an issue body with an empty artifact', async () => {
    const { repo, bin } = seedRepoWithGh(
      'app-gate-empty-issue',
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then touch "$FAKE_EDIT_MARKER"; exit 0; fi\n' +
        'exit 1\n',
    );
    const marker = join(bin, 'issue-edited');
    process.env.FAKE_EDIT_MARKER = marker;
    const body = join(repo, 'groomed-ticket.md');
    writeFileSync(body, '   \n\n');

    await expect(
      createRealAppGateGitHub(repo)('update-issue-body', {
        pr: null,
        ticket: 78,
        bodyFile: body,
        pickup: null,
      }),
    ).rejects.toThrow(/empty/i);
    expect(existsSync(marker)).toBe(false);
  });

  // The guard reads the artifact; `gh --body-file <path>` would open it again and publish a second,
  // possibly different read. Publish the bytes that were graded.
  it('publishes the artifact bytes it validated, not a re-read of the path', async () => {
    const { repo, bin } = seedRepoWithGh(
      'app-gate-issue-stdin',
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then cat > "$FAKE_EDIT_MARKER"; exit 0; fi\n' +
        'exit 1\n',
    );
    const marker = join(bin, 'issue-body');
    process.env.FAKE_EDIT_MARKER = marker;
    const body = join(repo, 'groomed-ticket.md');
    writeFileSync(body, '# Groomed\n');

    await createRealAppGateGitHub(repo)('update-issue-body', {
      pr: null,
      ticket: 78,
      bodyFile: body,
      pickup: null,
    });

    expect(readFileSync(marker, 'utf8')).toBe('# Groomed\n');
  });

  it('publishes a non-empty issue body artifact', async () => {
    const { repo, bin } = seedRepoWithGh(
      'app-gate-issue-body',
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then printf \'%s\\n\' "$*" > "$FAKE_EDIT_MARKER"; exit 0; fi\n' +
        'exit 1\n',
    );
    const marker = join(bin, 'issue-edited');
    process.env.FAKE_EDIT_MARKER = marker;
    const body = join(repo, 'groomed-ticket.md');
    writeFileSync(body, '# Groomed\n');

    await createRealAppGateGitHub(repo)('update-issue-body', {
      pr: null,
      ticket: 78,
      bodyFile: body,
      pickup: null,
    });

    expect(existsSync(marker)).toBe(true);
  });

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
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\\n\' \'{"number":42,"url":"https://github.com/owner/repository/pull/42","headRefName":"plan-loop/issue-78","state":"OPEN","closingIssuesReferences":[{"number":78,"url":"https://github.com/other/repository/issues/78"}],"isCrossRepository":false}\'; exit 0; fi\n' +
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
        pickup: {
          kind: 'opened',
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
          initialStatus: 'planning',
        },
      }),
    ).rejects.toThrow(/bootstrap PR identity/i);
    expect(existsSync(marker)).toBe(false);
  });

  // One rule for the port, not three: `updateIssueBody` refuses a blank artifact, so neither
  // `publishPullRequestBody` arm may publish one either.
  it('refuses to replace a PR body with an empty artifact', async () => {
    const { repo, bin } = seedRepoWithGh(
      'app-gate-empty-pr',
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then touch "$FAKE_EDIT_MARKER"; exit 0; fi\n' +
        'exit 1\n',
    );
    const marker = join(bin, 'pr-edited');
    process.env.FAKE_EDIT_MARKER = marker;
    const body = join(repo, 'plan.md');
    writeFileSync(body, '  \n');

    await expect(
      createRealAppGateGitHub(repo)('publish-pr-body', {
        pr: 42,
        ticket: null,
        bodyFile: body,
        pickup: null,
      }),
    ).rejects.toThrow(/empty/i);
    expect(existsSync(marker)).toBe(false);
  });
});
