import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealAppBootstrapPorts } from '../../src/main/appBootstrapPorts';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function seedRepo(prefix: string): { repo: string; bin: string; remote: string } {
  const repo = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const bin = mkdtempSync(join(tmpdir(), `${prefix}-bin-`));
  const remote = mkdtempSync(join(tmpdir(), `${prefix}-remote-`));
  cleanup.push(repo, bin, remote);
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['init', '--bare'], { cwd: remote });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'],
    { cwd: repo },
  );
  return { repo, bin, remote };
}

// The isolated remote dir cannot reach a real github.com from a test, so origin's fetch URL is rewritten
// to a local bare repo through INHERITED config — the layer the port neutralizes named keys in but does
// not forbid. `git remote get-url` (how the repository identity is read) applies that same rewrite, so
// the identity must be resolved and memoized BEFORE the redirect is installed, or it resolves to a
// file:// URL that is not a GitHub repository at all.
async function redirectOriginToLocal(
  prefix: string,
  remote: string,
  ports: ReturnType<typeof createRealAppBootstrapPorts>,
): Promise<void> {
  // The warm-up cannot fully succeed (the probe reaches the real origin, and the fakes answer for one
  // branch only), but it MUST get past origin-identity resolution — that is what memoizes the identity
  // before the redirect below. Swallowing every error here let a resolution failure resolve the identity
  // afterwards against a file:// URL, reproducing the very messages these tests assert on.
  const warmUp = await ports.conflicts
    .inspect('identity-warmup')
    .then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
  expect(warmUp ?? '').not.toMatch(
    /origin repository|invalid repository identity|invalid origin/i,
  );
  const configDir = mkdtempSync(join(tmpdir(), `${prefix}-config-`));
  cleanup.push(configDir);
  const config = join(configDir, 'gitconfig');
  execFileSync('git', [
    'config',
    '--file',
    config,
    `url.file://${remote}/.insteadOf`,
    'https://github.com/owner/repository.git',
  ]);
  process.env.GIT_CONFIG_GLOBAL = config;
}

describe('real app bootstrap conflict adapter (§27.10)', () => {
  it('refuses a mismatched pull-request identity before exposing a destructive target', async () => {
    const { repo, bin, remote } = seedRepo('bootstrap-conflict-identity');
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf \'%s\\n\' \'[{"number":42,"url":"https://github.com/attacker/other/pull/42","headRefOid":"2222222222222222222222222222222222222222","isCrossRepository":false,"headRepository":{"name":"repository"},"headRepositoryOwner":{"login":"owner"}}]\'; exit 0; fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const ports = createRealAppBootstrapPorts(repo);
    await redirectOriginToLocal('bootstrap-conflict-identity', remote, ports);

    await expect(ports.conflicts.inspect('plan-loop/issue-78')).rejects.toThrow(
      /mismatched identity/i,
    );
  });

  it('does not close a pull request whose head moved after inspection', async () => {
    const { repo, bin, remote } = seedRepo('bootstrap-conflict-github');
    const marker = join(bin, 'closed');
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"Owner/Repository","url":"https://github.com/Owner/Repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf \'%s\\n\' \'[{"number":42,"url":"https://github.com/Owner/Repository/pull/42","headRefOid":"2222222222222222222222222222222222222222","isCrossRepository":false,"headRepository":{"name":"Repository"},"headRepositoryOwner":{"login":"Owner"}}]\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\\n\' \'{"number":42,"url":"https://github.com/Owner/Repository/pull/42","state":"OPEN","headRefOid":"6666666666666666666666666666666666666666","isCrossRepository":false,"headRefName":"plan-loop/issue-78","headRepository":{"name":"Repository"},"headRepositoryOwner":{"login":"Owner"}}\'; exit 0; fi\n' +
        `if [ "$1" = "pr" ] && [ "$2" = "close" ]; then touch ${JSON.stringify(marker)}; exit 0; fi\n` +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const ports = createRealAppBootstrapPorts(repo);
    await redirectOriginToLocal('bootstrap-conflict-github', remote, ports);
    const target = await ports.conflicts.inspect('plan-loop/issue-78');

    await expect(ports.conflicts.wipe(target)).rejects.toThrow(
      /pull request changed before close/i,
    );
    expect(existsSync(marker)).toBe(false);
  });

  // The operator authorizes a specific set of resources; a PR that opens between the confirmation and the
  // wipe was never on that list, so the wipe must refuse rather than widen itself.
  it('refuses to wipe when a pull request appears after the operator confirmed', async () => {
    const { repo, bin, remote } = seedRepo('bootstrap-conflict-appeared');
    const marker = join(bin, 'closed');
    const listFile = join(bin, 'pr-list');
    writeFileSync(listFile, '[]\n');
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then cat ${JSON.stringify(listFile)}; exit 0; fi\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "close" ]; then touch ${JSON.stringify(marker)}; exit 0; fi\n` +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const ports = createRealAppBootstrapPorts(repo);
    await redirectOriginToLocal('bootstrap-conflict-appeared', remote, ports);
    const target = await ports.conflicts.inspect('plan-loop/issue-78');
    expect(target.pullRequests).toEqual([]);

    writeFileSync(
      listFile,
      '[{"number":7,"url":"https://github.com/owner/repository/pull/7","headRefOid":"3333333333333333333333333333333333333333","isCrossRepository":false,"headRepository":{"name":"repository"},"headRepositoryOwner":{"login":"owner"}}]\n',
    );

    await expect(ports.conflicts.wipe(target)).rejects.toThrow(
      /conflicting resources changed/i,
    );
    expect(existsSync(marker)).toBe(false);
  });
});
