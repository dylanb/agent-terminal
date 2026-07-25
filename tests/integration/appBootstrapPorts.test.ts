import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRealAppBootstrapPorts } from '../../src/main/appBootstrapPorts';

const cleanup: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

it('constructs working app bootstrap ports from a repository directory', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'app-bootstrap-ports-'));
  const bin = mkdtempSync(join(tmpdir(), 'app-bootstrap-ports-bin-'));
  cleanup.push(repo, bin);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo });
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
      'for a in "$@"; do if [ "$a" = "--jq" ]; then jq_next=1; elif [ -n "$jq_next" ]; then jq_filter=$a; jq_next=; fi; done\n' +
      'if [ "$jq_filter" = ".defaultBranchRef.name" ]; then printf \'%s\\n\' main; exit 0; fi\n' +
      'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
      'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then printf \'%s\\n\' \'{"title":"Ticket 78","url":"https://github.com/owner/repository/issues/78"}\'; exit 0; fi\n' +
      'exit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ''}`;

  const ports = await createRealAppBootstrapPorts(repo);

  await expect(ports.git.resolveBaseBranch()).resolves.toBe('main');
  await expect(ports.github.viewIssue(78)).resolves.toEqual({
    title: 'Ticket 78',
    url: 'https://github.com/owner/repository/issues/78',
  });
});
